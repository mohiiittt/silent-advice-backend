// server.js - Node.js backend for anonymous audio calls
//
// This backend implements a simple matchmaking service and audio‑only
// mediasoup SFU. It uses Express for HTTP APIs and Socket.io for
// signaling. Only two participants (advisor and listener) can join
// a room at a time. The server matches users by role and creates
// rooms on demand. Once both roles are present, it sets up
// mediasoup transports for each peer. The heavy media processing is
// handled by mediasoup's C++ worker, so Node.js performance is more
// than adequate for this use case, as multiple sources note that
// Node.js trails Go only marginally and that there is very little
// difference in real‑life performance【57135284341753†L310-L323】.

const express = require('express');
const http = require('http');
const cors = require('cors');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');
const { v4: uuidv4 } = require('uuid');
const { loadEnvFile } = require('process');

const PORT = process.env.PORT || 3000;

// Media codecs configuration: only Opus audio is enabled. The
// parameters mirror those suggested in the mediasoup examples.
const audioMediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: {
      useinbandfec: 1,
      spropstereo: 1,
    },
  },
];

// Keep a single mediasoup Worker and Router for simplicity. In a
// production deployment you might spawn multiple workers depending
// on CPU cores and create one Router per room. See the mediasoup
// documentation for details.
let worker;
let router;

// Rooms map: roomId -> { id, peers: Map(socketId -> peerInfo), roles }
// roles: { advisor: socketId | null, listener: socketId | null }
const rooms = new Map();

// Waiting map: role -> array of tokens waiting for a partner
const waiting = {
  advisor: [],
  listener: [],
};

/**
 * Match a user with an available partner or place them in the waiting
 * queue. Returns an object { roomId, ready } where ready indicates
 * whether both roles are present and the call can start immediately.
 * This helper centralizes the matchmaking logic so that /match and
 * /connect endpoints behave identically.
 */
function matchAndCreateRoom(token, role) {
  const opposite = role === 'advisor' ? 'listener' : 'advisor';
  // If there is a waiting user of the opposite role, create a room
  if (waiting[opposite].length > 0) {
    const partnerToken = waiting[opposite].shift();
    const roomId = uuidv4();
    rooms.set(roomId, {
      id: roomId,
      router,
      peers: new Map(),
      roles: {
        advisor: role === 'advisor' ? null : partnerToken,
        listener: role === 'listener' ? null : partnerToken,
      },
    });
    return { roomId, ready: true };
  }
  // Otherwise, add this user to waiting list and create placeholder room
  waiting[role].push(token);
  const roomId = uuidv4();
  rooms.set(roomId, {
    id: roomId,
    router,
    peers: new Map(),
    roles: { advisor: null, listener: null },
  });
  return { roomId, ready: false };
}

// Start the Express server and Socket.io
async function startServer() {
  // Create mediasoup worker
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({ mediaCodecs: audioMediaCodecs });

  const app = express();
  // Configure CORS to only allow requests from localhost:8081. Adjust
  // the origin as needed to match your client. Without this middleware
  // the browser will refuse cross‑origin requests from your Expo
  // development server.
  const corsOptions = {
    origin: loadEnvFile().CLIENT_ORIGIN,
    methods: 'GET,POST',
    allowedHeaders: ['Content-Type', 'Authorization'],
  };
  app.use(cors(corsOptions));
  app.use(express.json());

  // Basic ping route to measure latency from clients
  app.get('/ping', (req, res) => {
    res.json({ time: Date.now() });
  });

  /**
   * POST /match
   * Body: { token: string, role: 'advisor' | 'listener' }
   *
   * This endpoint matches a user with an available partner. If there is
   * already a waiting user of the opposite role, a room is assigned to
   * both. Otherwise, the caller is placed in the waiting queue. The
   * response includes a roomId and a flag indicating whether the call
   * should start immediately (both roles are present).
   */
  app.post('/match', (req, res) => {
    const { token, role } = req.body;
    if (!token || !role || !['advisor', 'listener'].includes(role)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    const result = matchAndCreateRoom(token, role);
    return res.json(result);
  });

  // Alias /connect to the same logic as /match. Some clients may
  // still call /connect instead of /match. We forward the request
  // through the same matching pipeline to avoid 404 errors.
  app.post('/connect', (req, res) => {
    const token = req.headers['authorization'];
    const { role } = req.body;
    
    const result = matchAndCreateRoom(token, role);
    return res.json(result);
  });

  const httpServer = http.createServer(app);
  const io = socketIo(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  // When a client connects via socket.io, set up mediasoup transports
  io.on('connection', (socket) => {
    console.log('client connected', socket.id);
    socket.on('disconnect', () => {
      console.log('client disconnected', socket.id);
      handleDisconnect(socket);
    });

    /**
     * Client requests to join a room.
     * data: { roomId: string, role: 'advisor' | 'listener' }
     * The server ensures only one advisor and one listener per room.
     * It creates a WebRTC transport for the peer and responds with
     * router capabilities and transport parameters.
     */
    socket.on('join', async (data, callback) => {
      const { roomId, role } = data;
      const room = rooms.get(roomId);
      if (!room) {
        return callback({ error: 'Room not found' });
      }
      if (!['advisor', 'listener'].includes(role)) {
        return callback({ error: 'Invalid role' });
      }
      // Ensure this role is vacant
      if (room.roles[role] && room.roles[role] !== socket.id) {
        return callback({ error: 'Role already taken' });
      }
      // Save socket as role
      room.roles[role] = socket.id;
      room.peers.set(socket.id, { socket, role, transports: [], producers: [], consumers: [] });
      // Create WebRTC transport
      try {
        const transport = await createWebRtcTransport(room.router);
        room.peers.get(socket.id).transports.push(transport);
        // Notify the client of router capabilities and transport info
        callback({
          rtpCapabilities: room.router.rtpCapabilities,
          transportOptions: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          },
        });
      } catch (err) {
        console.error('Error creating transport', err);
        callback({ error: 'Failed to create transport' });
      }
    });

    /**
     * Client calls this when its transport is connected (DTLS handshake done).
     */
    socket.on('connectTransport', async (data, callback) => {
      const { roomId, dtlsParameters } = data;
      const room = rooms.get(roomId);
      if (!room) return callback({ error: 'Room not found' });
      const peer = room.peers.get(socket.id);
      if (!peer) return callback({ error: 'Peer not found' });
      const transport = peer.transports[0];
      try {
        await transport.connect({ dtlsParameters });
        callback({ connected: true });
      } catch (err) {
        console.error('Error connecting transport', err);
        callback({ error: 'Transport connection failed' });
      }
    });

    /**
     * Client produces an audio track.
     * data: { roomId, kind, rtpParameters }
     */
    socket.on('produce', async (data, callback) => {
      const { roomId, kind, rtpParameters } = data;
      const room = rooms.get(roomId);
      const peer = room?.peers.get(socket.id);
      if (!room || !peer) return callback({ error: 'Room or peer not found' });
      const transport = peer.transports[0];
      try {
        const producer = await transport.produce({ kind, rtpParameters });
        peer.producers.push(producer);
        // Inform other peer to consume
        const otherRole = peer.role === 'advisor' ? 'listener' : 'advisor';
        const otherSocketId = room.roles[otherRole];
        if (otherSocketId) {
          io.to(otherSocketId).emit('newProducer', { roomId, producerId: producer.id, kind });
        }
        callback({ id: producer.id });
      } catch (err) {
        console.error('Error producing', err);
        callback({ error: 'Production failed' });
      }
    });

    /**
     * Client consumes an audio track from a producer.
     * data: { roomId, producerId, rtpCapabilities }
     */
    socket.on('consume', async (data, callback) => {
      const { roomId, producerId, rtpCapabilities } = data;
      const room = rooms.get(roomId);
      const peer = room?.peers.get(socket.id);
      if (!room || !peer) return callback({ error: 'Room or peer not found' });
      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        return callback({ error: 'Cannot consume' });
      }
      const transport = peer.transports[0];
      try {
        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: false,
        });
        peer.consumers.push(consumer);
        consumer.on('transportclose', () => {
          // Remove consumer from peer
          const idx = peer.consumers.indexOf(consumer);
          if (idx > -1) peer.consumers.splice(idx, 1);
        });
        callback({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (err) {
        console.error('Error consuming', err);
        callback({ error: 'Consume failed' });
      }
    });
  });

  /**
   * Helper: remove peer from room on disconnect and close its transports and producers.
   */
  function handleDisconnect(socket) {
    for (const [roomId, room] of rooms) {
      if (room.peers.has(socket.id)) {
        const peer = room.peers.get(socket.id);
        // Close transports
        peer.transports.forEach((t) => t.close());
        // Close producers and consumers
        peer.producers.forEach((p) => p.close());
        peer.consumers.forEach((c) => c.close());
        room.peers.delete(socket.id);
        room.roles[peer.role] = null;
        // If no peers remain, delete the room
        if (room.peers.size === 0) {
          rooms.delete(roomId);
        }
        break;
      }
    }
  }

  /**
   * Helper: create a WebRTC transport with given router
   */
  async function createWebRtcTransport(router) {
    const transport = await router.createWebRtcTransport({
      listenIps: [
        { ip: '0.0.0.0', announcedIp: null }, // Replace announcedIp with public IP in production
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      appData: {},
    });
    return transport;
  }

  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error(err);
});