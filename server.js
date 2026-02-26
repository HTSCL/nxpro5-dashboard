require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-me-in-env";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Rate limiting
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use("/api/", limiter);

// ─── In-memory state ────────────────────────────────────────────────────────
let systemState = {
  status: "normal",        // normal | evacuate | trouble | classchange | alarm | silenced
  lastCommand: null,
  lastCommandTime: null,
  events: [],              // log of events
  zones: {
    "1": { name: "Reception",    status: "normal" },
    "2": { name: "Waiting Room", status: "normal" },
    "3": { name: "Staff Room",   status: "normal" },
    "4": { name: "Basement",     status: "normal" },
    "5": { name: "Office 1",     status: "normal" },
    "6": { name: "Office 2",     status: "normal" },
  },
  timedEvents: [],
};

// Pending commands queue – Roblox polls this
let pendingCommands = [];

// ─── Auth middleware ─────────────────────────────────────────────────────────
function authCheck(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function addEvent(type, message, zone = null) {
  const entry = {
    id: Date.now(),
    type,
    message,
    zone,
    time: new Date().toISOString(),
  };
  systemState.events.unshift(entry);
  if (systemState.events.length > 100) systemState.events.pop();
  return entry;
}

// ─── DASHBOARD API ───────────────────────────────────────────────────────────

// Get full system state
app.get("/api/state", authCheck, (req, res) => {
  res.json(systemState);
});

// Send a command to Roblox
app.post("/api/command", authCheck, (req, res) => {
  const { command, zone, params } = req.body;
  const allowed = ["Evacuate", "Trouble", "ClassChange", "Silence", "Reset", "Alarm", "TestZone", "RemoveTestZone"];

  if (!allowed.includes(command)) {
    return res.status(400).json({ error: "Unknown command: " + command });
  }

  const cmd = {
    id: Date.now(),
    command,
    zone: zone || null,
    params: params || {},
    timestamp: new Date().toISOString(),
  };

  pendingCommands.push(cmd);

  // Update local state
  systemState.lastCommand = command;
  systemState.lastCommandTime = cmd.timestamp;

  const statusMap = {
    Evacuate: "evacuate",
    Trouble: "trouble",
    ClassChange: "classchange",
    Alarm: "alarm",
    Silence: "silenced",
    Reset: "normal",
  };
  if (statusMap[command]) systemState.status = statusMap[command];
  if (command === "Reset") {
    Object.values(systemState.zones).forEach(z => z.status = "normal");
  }
  if (zone && systemState.zones[zone] && statusMap[command]) {
    systemState.zones[zone].status = statusMap[command];
  }

  addEvent(command.toLowerCase(), `Command sent: ${command}${zone ? ` (Zone ${zone})` : ""}`, zone);

  res.json({ ok: true, cmd });
});

// Update zone name
app.put("/api/zones/:id", authCheck, (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!systemState.zones[id]) return res.status(404).json({ error: "Zone not found" });
  systemState.zones[id].name = name;
  res.json({ ok: true });
});

// Timed events CRUD
app.get("/api/timed-events", authCheck, (req, res) => {
  res.json(systemState.timedEvents);
});

app.post("/api/timed-events", authCheck, (req, res) => {
  const { name, date, time, command } = req.body;
  if (!name || !date || !time || !command)
    return res.status(400).json({ error: "Missing fields" });
  const ev = { id: Date.now(), name, date, time, command, enabled: true };
  systemState.timedEvents.push(ev);
  // Queue push to Roblox
  pendingCommands.push({
    id: Date.now(),
    command: "NewTimedEvent",
    params: { name, date, time, command },
    timestamp: new Date().toISOString(),
  });
  addEvent("timed_event", `Timed event created: ${name} → ${command} at ${date} ${time}`);
  res.json(ev);
});

app.delete("/api/timed-events/:id", authCheck, (req, res) => {
  const id = parseInt(req.params.id);
  const idx = systemState.timedEvents.findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  const ev = systemState.timedEvents[idx];
  systemState.timedEvents.splice(idx, 1);
  pendingCommands.push({
    id: Date.now(),
    command: "DeleteTimedEvent",
    params: { name: ev.name, date: ev.date, time: ev.time, command: ev.command },
    timestamp: new Date().toISOString(),
  });
  addEvent("timed_event_delete", `Timed event deleted: ${ev.name}`);
  res.json({ ok: true });
});

// Get event log
app.get("/api/events", authCheck, (req, res) => {
  res.json(systemState.events);
});

// ─── ROBLOX POLLING API ──────────────────────────────────────────────────────
// Roblox server script polls this to get pending commands

app.get("/roblox/poll", (req, res) => {
  const key = req.headers["x-roblox-key"] || req.query.key;
  if (key !== (process.env.ROBLOX_KEY || "roblox-secret")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const cmds = [...pendingCommands];
  pendingCommands = [];
  res.json({ commands: cmds });
});

// Roblox pushes state updates here
app.post("/roblox/event", (req, res) => {
  const key = req.headers["x-roblox-key"] || req.query.key;
  if (key !== (process.env.ROBLOX_KEY || "roblox-secret")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { event, zone, device, location } = req.body;
  if (event) {
    const statusMap = {
      Evacuate: "evacuate", Trouble: "trouble",
      ClassChange: "classchange", Alarm: "alarm",
      Silence: "silenced", Reset: "normal",
    };
    if (statusMap[event]) systemState.status = statusMap[event];
    if (event === "Reset") Object.values(systemState.zones).forEach(z => z.status = "normal");
    if (zone && systemState.zones[zone] && statusMap[event]) {
      systemState.zones[zone].status = statusMap[event];
    }
    addEvent(event.toLowerCase(), `[Roblox] ${event}${zone ? ` – Zone ${zone}` : ""}${device ? ` – ${device}` : ""}`, zone);
  }
  res.json({ ok: true });
});

// ─── Serve frontend ──────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`NXPro5 Dashboard running on port ${PORT}`));
