Content is user-generated and unverified.
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e8, // 100MB for video chunks
});

// ── Storage ──────────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB max
  fileFilter: (req, file, cb) => {
    const allowed = ["video/mp4", "video/webm", "video/ogg", "video/mkv", "video/x-matroska"];
    cb(null, allowed.includes(file.mimetype) || file.originalname.match(/\.(mp4|webm|ogv|mkv)$/i));
  },
});

// ── In-memory room state ──────────────────────────────────────────────────────
// rooms[roomId] = {
//   id, hostId, videoFile, videoName,
//   players: { [socketId]: { name, isHost } },
//   playback: { isPlaying, currentTime, lastUpdated },
//   chat: [ { id, sender, text, emoji, timestamp } ],
//   webrtcSignals: {}
// }
const rooms = new Map();

function createRoom(hostId) {
  const id = uuidv4().slice(0, 8).toUpperCase();
  rooms.set(id, {
    id,
    hostId,
    videoFile: null,
    videoName: null,
    players: {},
    playback: { isPlaying: false, currentTime: 0, lastUpdated: Date.now() },
    chat: [],
  });
  return rooms.get(id);
}

function getRoom(id) {
  return rooms.get(id) || null;
}

function getCurrentTime(room) {
  if (!room.playback.isPlaying) return room.playback.currentTime;
  const elapsed = (Date.now() - room.playback.lastUpdated) / 1000;
  return room.playback.currentTime + elapsed;
}

// ── HTTP Routes ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Create a new room
app.post("/api/rooms", (req, res) => {
  const room = createRoom(null); // hostId set when socket connects
  res.json({ roomId: room.id });
});

// Check room exists
app.get("/api/rooms/:roomId", (req, res) => {
  const room = getRoom(req.params.roomId.toUpperCase());
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({
    roomId: room.id,
    hasVideo: !!room.videoFile,
    videoName: room.videoName,
    playerCount: Object.keys(room.players).length,
  });
});

// Upload video to a room (host only)
app.post("/api/rooms/:roomId/upload", upload.single("video"), (req, res) => {
  const room = getRoom(req.params.roomId.toUpperCase());
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (!req.file) return res.status(400).json({ error: "No video file provided" });

  // Delete previous video if any
  if (room.videoFile) {
    fs.unlink(path.join(UPLOADS_DIR, room.videoFile), () => {});
  }

  room.videoFile = req.file.filename;
  room.videoName = req.file.originalname;
  room.playback = { isPlaying: false, currentTime: 0, lastUpdated: Date.now() };

  // Notify everyone in room
  io.to(room.id).emit("video:ready", { videoName: room.videoName });

  res.json({ success: true, videoName: room.videoName });
});

// Stream video with range support (low-bandwidth friendly)
app.get("/api/rooms/:roomId/video", (req, res) => {
  const room = getRoom(req.params.roomId.toUpperCase());
  if (!room || !room.videoFile) return res.status(404).json({ error: "No video" });

  const filePath = path.join(UPLOADS_DIR, room.videoFile);
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    // Range request — send only the requested chunk
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 1024 * 1024, fileSize - 1); // 1MB chunks
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "video/mp4",
      "Cache-Control": "no-cache",
    });

    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ── Socket.io — Real-time layer ───────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[socket] connected: ${socket.id}`);

  // ── Join room ──
  socket.on("room:join", ({ roomId, name }) => {
    const room = getRoom(roomId?.toUpperCase());
    if (!room) return socket.emit("error", { message: "Room not found" });

    const upperRoomId = roomId.toUpperCase();
    socket.join(upperRoomId);
    socket.data.roomId = upperRoomId;
    socket.data.name = name || "Guest";

    // First person in room becomes host
    const isHost = Object.keys(room.players).length === 0;
    if (isHost) room.hostId = socket.id;

    room.players[socket.id] = { name: socket.data.name, isHost };

    // Send current state to joining user
    socket.emit("room:joined", {
      roomId: upperRoomId,
      isHost,
      name: socket.data.name,
      hasVideo: !!room.videoFile,
      videoName: room.videoName,
      playback: {
        isPlaying: room.playback.isPlaying,
        currentTime: getCurrentTime(room),
      },
      players: Object.values(room.players),
      chat: room.chat.slice(-50), // last 50 messages
    });

    // Notify others
    socket.to(upperRoomId).emit("room:player_joined", {
      name: socket.data.name,
      players: Object.values(room.players),
    });

    console.log(`[room:${upperRoomId}] ${socket.data.name} joined (host: ${isHost})`);
  });

  // ── Playback sync (host-driven) ──
  socket.on("playback:play", ({ currentTime }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.hostId !== socket.id) return;

    room.playback = { isPlaying: true, currentTime, lastUpdated: Date.now() };
    socket.to(room.id).emit("playback:play", { currentTime, timestamp: Date.now() });
    console.log(`[room:${room.id}] play at ${currentTime.toFixed(1)}s`);
  });

  socket.on("playback:pause", ({ currentTime }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.hostId !== socket.id) return;

    room.playback = { isPlaying: false, currentTime, lastUpdated: Date.now() };
    socket.to(room.id).emit("playback:pause", { currentTime });
    console.log(`[room:${room.id}] pause at ${currentTime.toFixed(1)}s`);
  });

  socket.on("playback:seek", ({ currentTime }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.hostId !== socket.id) return;

    room.playback.currentTime = currentTime;
    room.playback.lastUpdated = Date.now();
    socket.to(room.id).emit("playback:seek", { currentTime });
    console.log(`[room:${room.id}] seek to ${currentTime.toFixed(1)}s`);
  });

  // Guest requests current sync state
  socket.on("playback:sync_request", () => {
    const room = getRoom(socket.data.roomId);
    if (!room) return;
    socket.emit("playback:sync", {
      isPlaying: room.playback.isPlaying,
      currentTime: getCurrentTime(room),
      timestamp: Date.now(),
    });
  });

  // ── Chat ──
  socket.on("chat:message", ({ text }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || !text?.trim()) return;

    const message = {
      id: uuidv4(),
      sender: socket.data.name,
      text: text.trim().slice(0, 500),
      timestamp: Date.now(),
    };
    room.chat.push(message);
    if (room.chat.length > 200) room.chat.shift();

    io.to(room.id).emit("chat:message", message);
  });

  // ── Emoji reactions ──
  socket.on("reaction:send", ({ emoji }) => {
    const room = getRoom(socket.data.roomId);
    if (!room) return;
    const allowed = ["❤️", "😂", "😮", "😢", "👏", "🔥", "🍿", "😍"];
    if (!allowed.includes(emoji)) return;

    io.to(room.id).emit("reaction:burst", {
      emoji,
      sender: socket.data.name,
      id: uuidv4(),
    });
  });

  // ── WebRTC signaling for voice/video chat ──
  socket.on("webrtc:offer", ({ targetId, offer }) => {
    io.to(targetId).emit("webrtc:offer", { fromId: socket.id, fromName: socket.data.name, offer });
  });

  socket.on("webrtc:answer", ({ targetId, answer }) => {
    io.to(targetId).emit("webrtc:answer", { fromId: socket.id, answer });
  });

  socket.on("webrtc:ice_candidate", ({ targetId, candidate }) => {
    io.to(targetId).emit("webrtc:ice_candidate", { fromId: socket.id, candidate });
  });

  // Request list of peers for WebRTC mesh
  socket.on("webrtc:get_peers", () => {
    const room = getRoom(socket.data.roomId);
    if (!room) return;
    const peers = Object.entries(room.players)
      .filter(([id]) => id !== socket.id)
      .map(([id, p]) => ({ socketId: id, name: p.name }));
    socket.emit("webrtc:peers", { peers });
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    const room = getRoom(socket.data.roomId);
    if (!room) return;

    const name = socket.data.name;
    delete room.players[socket.id];

    // If host left, assign new host
    if (room.hostId === socket.id) {
      const nextId = Object.keys(room.players)[0];
      if (nextId) {
        room.hostId = nextId;
        room.players[nextId].isHost = true;
        io.to(nextId).emit("room:promoted_to_host");
        io.to(room.id).emit("room:host_changed", { newHostName: room.players[nextId].name });
      }
    }

    io.to(room.id).emit("room:player_left", {
      name,
      players: Object.values(room.players),
    });

    // Clean up empty rooms after 10 minutes
    if (Object.keys(room.players).length === 0) {
      setTimeout(() => {
        const r = getRoom(room.id);
        if (r && Object.keys(r.players).length === 0) {
          if (r.videoFile) fs.unlink(path.join(UPLOADS_DIR, r.videoFile), () => {});
          rooms.delete(room.id);
          console.log(`[room:${room.id}] cleaned up`);
        }
      }, 10 * 60 * 1000);
    }

    console.log(`[room:${room.id}] ${name} left`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎬 ReelTwo server running at http://localhost:${PORT}\n`);
});

