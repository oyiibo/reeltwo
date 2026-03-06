const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;

cloudinary.config({
cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
api_key: process.env.CLOUDINARY_API_KEY,
api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
cors: { origin: "*", methods: ["GET", "POST"] },
maxHttpBufferSize: 1e8,
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
const rooms = new Map();

function createRoom() {
const id = uuidv4().slice(0, 8).toUpperCase();
rooms.set(id, {
id, hostId: null,
videoUrl: null, videoName: null,
players: {},
playback: { isPlaying: false, currentTime: 0, lastUpdated: Date.now() },
chat: [],
});
return rooms.get(id);
}

function getRoom(id) { return rooms.get(id) || null; }

function getCurrentTime(room) {
if (!room.playback.isPlaying) return room.playback.currentTime;
return room.playback.currentTime + (Date.now() - room.playback.lastUpdated) / 1000;
}

app.use(express.json());
app.use(express.static("public"));

app.post("/api/rooms", (req, res) => {
const room = createRoom();
res.json({ roomId: room.id });
});

app.get("/api/rooms/:roomId", (req, res) => {
const room = getRoom(req.params.roomId.toUpperCase());
if (!room) return res.status(404).json({ error: "Room not found" });
res.json({ roomId: room.id, hasVideo: !!room.videoUrl, videoName: room.videoName, videoUrl: room.videoUrl });
});

app.post("/api/rooms/:roomId/upload", upload.single("video"), async (req, res) => {
const room = getRoom(req.params.roomId.toUpperCase());
if (!room) return res.status(404).json({ error: "Room not found" });
if (!req.file) return res.status(400).json({ error: "No file" });

try {
const result = await new Promise((resolve, reject) => {
const stream = cloudinary.uploader.upload_stream(
{
resource_type: "video",
folder: "reeltwo",
timeout: 120000,
eager: [{ streaming_profile: "full_hd", format: "mp4" }],
eager_async: false,
},
(error, result) => error ? reject(error) : resolve(result)
);
stream.end(req.file.buffer);
});

room.videoUrl = result.eager?.[0]?.secure_url || result.secure_url;

room.videoUrl = result.secure_url;
room.videoName = req.file.originalname;
room.playback = { isPlaying: false, currentTime: 0, lastUpdated: Date.now() };
io.to(room.id).emit("video:ready", { videoName: room.videoName, videoUrl: room.videoUrl });
res.json({ success: true, videoUrl: room.videoUrl });
} catch (err) {
console.error("Cloudinary upload error:", err);
res.status(500).json({ error: "Upload failed" });
}
});

io.on("connection", (socket) => {
socket.on("room:join", ({ roomId, name }) => {
const room = getRoom(roomId?.toUpperCase());
if (!room) return socket.emit("error", { message: "Room not found" });
const id = roomId.toUpperCase();
socket.join(id);
socket.data.roomId = id;
socket.data.name = name || "Guest";
const isHost = Object.keys(room.players).length === 0;
if (isHost) room.hostId = socket.id;
room.players[socket.id] = { name: socket.data.name, isHost };
socket.emit("room:joined", {
roomId: id, isHost, name: socket.data.name,
hasVideo: !!room.videoUrl, videoName: room.videoName, videoUrl: room.videoUrl,
playback: { isPlaying: room.playback.isPlaying, currentTime: getCurrentTime(room) },
players: Object.values(room.players),
chat: room.chat.slice(-50),
});
socket.to(id).emit("room:player_joined", { name: socket.data.name, players: Object.values(room.players) });
});

socket.on("playback:play", ({ currentTime }) => {
const room = getRoom(socket.data.roomId);
if (!room || room.hostId !== socket.id) return;
room.playback = { isPlaying: true, currentTime, lastUpdated: Date.now() };
socket.to(room.id).emit("playback:play", { currentTime, timestamp: Date.now() });
});

socket.on("playback:pause", ({ currentTime }) => {
const room = getRoom(socket.data.roomId);
if (!room || room.hostId !== socket.id) return;
room.playback = { isPlaying: false, currentTime, lastUpdated: Date.now() };
socket.to(room.id).emit("playback:pause", { currentTime });
});

socket.on("playback:seek", ({ currentTime }) => {
const room = getRoom(socket.data.roomId);
if (!room || room.hostId !== socket.id) return;
room.playback.currentTime = currentTime;
room.playback.lastUpdated = Date.now();
socket.to(room.id).emit("playback:seek", { currentTime });
});

socket.on("playback:sync_request", () => {
const room = getRoom(socket.data.roomId);
if (!room) return;
socket.emit("playback:sync", { isPlaying: room.playback.isPlaying, currentTime: getCurrentTime(room), timestamp: Date.now() });
});

socket.on("chat:message", ({ text }) => {
const room = getRoom(socket.data.roomId);
if (!room || !text?.trim()) return;
const message = { id: uuidv4(), sender: socket.data.name, text: text.trim().slice(0, 500), timestamp: Date.now() };
room.chat.push(message);
if (room.chat.length > 200) room.chat.shift();
io.to(room.id).emit("chat:message", message);
});

socket.on("reaction:send", ({ emoji }) => {
const room = getRoom(socket.data.roomId);
if (!room) return;
const allowed = ["❤️","😂","😮","😢","👏","🔥","🍿","😍"];
if (!allowed.includes(emoji)) return;
io.to(room.id).emit("reaction:burst", { emoji, sender: socket.data.name, id: uuidv4() });
});

socket.on("webrtc:offer", ({ targetId, offer }) => io.to(targetId).emit("webrtc:offer", { fromId: socket.id, fromName: socket.data.name, offer }));
socket.on("webrtc:answer", ({ targetId, answer }) => io.to(targetId).emit("webrtc:answer", { fromId: socket.id, answer }));
socket.on("webrtc:ice_candidate", ({ targetId, candidate }) => io.to(targetId).emit("webrtc:ice_candidate", { fromId: socket.id, candidate }));
socket.on("webrtc:get_peers", () => {
const room = getRoom(socket.data.roomId);
if (!room) return;
socket.emit("webrtc:peers", { peers: Object.entries(room.players).filter(([id]) => id !== socket.id).map(([id, p]) => ({ socketId: id, name: p.name })) });
});

socket.on("disconnect", () => {
const room = getRoom(socket.data.roomId);
if (!room) return;
const name = socket.data.name;
delete room.players[socket.id];
if (room.hostId === socket.id) {
const nextId = Object.keys(room.players)[0];
if (nextId) { room.hostId = nextId; room.players[nextId].isHost = true; io.to(nextId).emit("room:promoted_to_host"); }
}
io.to(room.id).emit("room:player_left", { name, players: Object.values(room.players) });
});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ReelTwo running on port ${PORT}`));
