const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// ✅ زيدنا pingTimeout شوي للموبايل
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 60000,
});

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const rooms = {};
// rooms[roomCode] = {
//   players: [{ id, key, name, score, connected, lastSeen }],
//   startReady: { [playerKey]: true },
//   round: { leaderId, outsiderId, topic, phase, votes: { [voterKey]: targetId }, voteOpen, nextReady: { [playerKey]: true } },
//   disconnectTimers: { [playerKey]: timeoutObj }
// }

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[اأإآ]/g, "ا")
    .replace(/[ة]/g, "ه")
    .replace(/[ى]/g, "ي");
}

function getRoom(roomCode) {
  if (!rooms[roomCode]) {
    rooms[roomCode] = {
      players: [],
      startReady: {},
      disconnectTimers: {},
      round: {
        leaderId: null,
        outsiderId: null,
        topic: null,
        phase: "idle",
        votes: {},
        voteOpen: false,
        nextReady: {},
      },
    };
  }
  return rooms[roomCode];
}

function emitRoomUpdate(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  io.to(roomCode).emit("room_update", {
    players: room.players.map((p) => ({
      name: p.name + (p.connected ? "" : " (غير متصل)"),
      score: p.score,
    })),
  });
}

function safePlayersList(room) {
  return room.players.map((p) => ({ id: p.id, name: p.name }));
}

function totalVoters(room) {
  // المصوتين = كل اللاعبين ما عدا المسؤول (وبدنا يكونوا متصلين؟)
  // خليته الكل حتى لو فصل لحظات، لأن رح يرجع ويصوت. بس لو بدك "فقط المتصلين" قلّي.
  return room.players.filter((p) => p.id !== room.round.leaderId).length;
}

function startNewRoundInternal(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.players.length < 3) {
    io.to(roomCode).emit("error_msg", "لازم على الأقل 3 لاعبين");
    return;
  }

  const leader = pickRandom(room.players);
  let outsider = pickRandom(room.players);
  while (outsider.id === leader.id) outsider = pickRandom(room.players);

  room.startReady = {};

  room.round = {
    leaderId: leader.id,
    outsiderId: outsider.id,
    topic: null,
    phase: "waiting_topic",
    votes: {},
    voteOpen: false,
    nextReady: {},
  };

  io.to(roomCode).emit("round_started", { leaderName: leader.name });
  io.to(room.round.leaderId).emit("leader_prompt_topic");
  io.to(roomCode).emit("start_round_progress", { readyCount: 0, total: room.players.length });
}

function finishVoting(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.round.voteOpen = false;

  const counts = {};
  for (const voterKey of Object.keys(room.round.votes)) {
    const targetId = room.round.votes[voterKey];
    counts[targetId] = (counts[targetId] || 0) + 1;
  }

  // ✅ المرشحين للتهمة: كل اللاعبين ما عدا المسؤول
  const candidates = room.players.filter((p) => p.id !== room.round.leaderId);

  let max = -1;
  let topIds = [];
  for (const p of candidates) {
    const c = counts[p.id] || 0;
    if (c > max) {
      max = c;
      topIds = [p.id];
    } else if (c === max) {
      topIds.push(p.id);
    }
  }

  const accusedId = pickRandom(topIds);

  const outsiderId = room.round.outsiderId;
  const outsiderCaught = accusedId === outsiderId;

  // نقاط: اللي صوّت للبرا السالفة +1 (فقط إذا انكشف فعلاً)
  if (outsiderCaught) {
    for (const voterKey of Object.keys(room.round.votes)) {
      if (room.round.votes[voterKey] === outsiderId) {
        const voter = room.players.find((p) => p.key === voterKey);
        if (voter) voter.score += 1;
      }
    }
  }

  const accused = room.players.find((p) => p.id === accusedId);
  const outsider = room.players.find((p) => p.id === outsiderId);

  room.round.phase = "outsider_guess";

  io.to(roomCode).emit("voting_result", {
    accusedName: accused?.name || "—",
    outsiderCaught,
    outsiderName: outsider?.name || "—",
  });

  io.to(outsiderId).emit("outsider_guess_prompt");
  emitRoomUpdate(roomCode);
}

io.on("connection", (socket) => {
  // ✅ Join or Re-Join بواسطة playerKey
  socket.on("join_room", ({ roomCode, name, playerKey }) => {
    const room = getRoom(roomCode);

    const cleanName = (name || "").trim();
    const key = (playerKey || "").trim();
    if (!cleanName || !key) {
      socket.emit("error_msg", "مشكلة بالاسم/الهوية، جرّب حدّث الصفحة");
      return;
    }

    // إذا كان فيه تايمر حذف لنفس اللاعب، ألغيه
    if (room.disconnectTimers[key]) {
      clearTimeout(room.disconnectTimers[key]);
      delete room.disconnectTimers[key];
    }

    // هل هذا اللاعب موجود من قبل؟
    const existing = room.players.find((p) => p.key === key);

    if (existing) {
      // ✅ Reconnect: بدّل socket.id وارجعه متصل
      // اطلع socket من الروم القديمة لو لازم
      existing.id = socket.id;
      existing.connected = true;
      existing.lastSeen = Date.now();

      socket.join(roomCode);

      socket.emit("join_ok", { rejoined: true, name: existing.name, score: existing.score });
      emitRoomUpdate(roomCode);
      return;
    }

    // لاعب جديد: منع تكرار الاسم
    const nameTaken = room.players.some((p) => p.name === cleanName);
    if (nameTaken) {
      socket.emit("error_msg", "الاسم مستخدم داخل الغرفة، اختار اسم ثاني");
      return;
    }

    room.players.push({
      id: socket.id,
      key,
      name: cleanName,
      score: 0,
      connected: true,
      lastSeen: Date.now(),
    });

    socket.join(roomCode);

    socket.emit("join_ok", { rejoined: false, name: cleanName, score: 0 });
    emitRoomUpdate(roomCode);

    io.to(roomCode).emit("start_round_progress", {
      readyCount: Object.keys(room.startReady).length,
      total: room.players.length,
    });

    if (room.round.phase === "results") {
      io.to(roomCode).emit("next_round_progress", {
        readyCount: Object.keys(room.round.nextReady || {}).length,
        total: room.players.length,
      });
    }
  });

  // ✅ جاهز لبدء الجولة (بالـ key مش socket.id)
  socket.on("ready_start_round", ({ roomCode, playerKey }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const phase = room.round.phase;
    if (!(phase === "idle" || phase === "results")) {
      socket.emit("error_msg", "في جولة شغالة… ما بزبط تبدأ جولة جديدة الآن");
      return;
    }

    room.startReady[playerKey] = true;

    const readyCount = Object.keys(room.startReady).length;
    const total = room.players.length;

    io.to(roomCode).emit("start_round_progress", { readyCount, total });

    if (readyCount >= total) {
      room.startReady = {};
      startNewRoundInternal(roomCode);
    }
  });

  socket.on("submit_topic", ({ roomCode, topic }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (socket.id !== room.round.leaderId) return;

    const safeTopic = (topic || "").trim();
    if (!safeTopic) {
      socket.emit("error_msg", "اكتب الكلمة/الموضوع قبل الإرسال");
      return;
    }

    room.round.topic = safeTopic;
    room.round.phase = "discussion";

    room.players.forEach((p) => {
      if (p.id === room.round.outsiderId) io.to(p.id).emit("topic_hidden");
      else io.to(p.id).emit("topic_revealed", { topic: safeTopic });
    });

    io.to(roomCode).emit("discussion_ready");
    io.to(room.round.leaderId).emit("leader_topic_locked");
  });

  // ✅ فتح التصويت: لا نرسل شاشة التصويت للمسؤول + القائمة بدون نفسك
  socket.on("open_voting", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.round.phase !== "discussion") {
      socket.emit("error_msg", "مش وقت التصويت الآن");
      return;
    }

    room.round.phase = "voting";
    room.round.votes = {};
    room.round.voteOpen = true;

    io.to(roomCode).emit("vote_progress", { votedCount: 0, total: totalVoters(room) });

    room.players.forEach((p) => {
      if (p.id === room.round.leaderId) return; // المسؤول لا يرى شاشة التصويت

      const candidates = room.players
        .filter((x) => x.id !== room.round.leaderId && x.id !== p.id)
        .map((x) => ({ id: x.id, name: x.name }));

      io.to(p.id).emit("voting_open", { players: candidates });
    });
  });

  // ✅ إرسال صوت: نخزن votes بمفتاح اللاعب (playerKey)
  socket.on("submit_vote", ({ roomCode, playerKey, targetId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.round.phase !== "voting" || !room.round.voteOpen) return;

    // ممنوع المسؤول يصوت
    if (socket.id === room.round.leaderId) {
      socket.emit("error_msg", "المسؤول ما بصوّت");
      return;
    }

    // ممنوع تصوت على حالك
    const me = room.players.find((p) => p.key === playerKey);
    if (me && me.id === targetId) {
      socket.emit("error_msg", "ما بتقدر تصوّت على حالك");
      return;
    }

    // ممنوع تصوت على المسؤول
    if (targetId === room.round.leaderId) {
      socket.emit("error_msg", "ما بزبط تصوّت على المسؤول");
      return;
    }

    const target = room.players.find((p) => p.id === targetId);
    if (!target) {
      socket.emit("error_msg", "اختيار غير صالح");
      return;
    }

    room.round.votes[playerKey] = targetId;

    io.to(roomCode).emit("vote_progress", {
      votedCount: Object.keys(room.round.votes).length,
      total: totalVoters(room),
    });

    if (Object.keys(room.round.votes).length === totalVoters(room)) {
      finishVoting(roomCode);
    }
  });

  socket.on("submit_outsider_guess", ({ roomCode, guess }) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.round.phase !== "outsider_guess") return;
    if (socket.id !== room.round.outsiderId) return;

    const g = (guess || "").trim();
    if (!g) {
      socket.emit("error_msg", "اكتب تخمينك");
      return;
    }

    const correct = normalize(g) === normalize(room.round.topic || "");
    const outsider = room.players.find((p) => p.id === room.round.outsiderId);
    if (outsider && correct) outsider.score += 2;

    room.round.phase = "results";
    room.round.nextReady = {};

    io.to(roomCode).emit("round_results", {
      correct,
      topic: room.round.topic,
      scoreboard: room.players
        .map((p) => ({ name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score),
    });

    emitRoomUpdate(roomCode);
  });

  socket.on("ready_next_round", ({ roomCode, playerKey }) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.round.phase !== "results") {
      socket.emit("error_msg", "مش وقت جولة جديدة الآن");
      return;
    }

    room.round.nextReady[playerKey] = true;

    const readyCount = Object.keys(room.round.nextReady).length;
    const total = room.players.length;

    io.to(roomCode).emit("next_round_progress", { readyCount, total });

    if (readyCount >= total) {
      room.round.nextReady = {};
      startNewRoundInternal(roomCode);
    }
  });

  // ✅ Disconnect: لا تحذف فورًا — فترة سماح
  socket.on("disconnect", () => {
    for (const roomCode of Object.keys(rooms)) {
      const room = rooms[roomCode];

      const player = room.players.find((p) => p.id === socket.id);
      if (!player) continue;

      player.connected = false;
      player.lastSeen = Date.now();

      emitRoomUpdate(roomCode);

      // ✅ فترة سماح 90 ثانية قبل الحذف النهائي
      const key = player.key;
      if (room.disconnectTimers[key]) clearTimeout(room.disconnectTimers[key]);

      room.disconnectTimers[key] = setTimeout(() => {
        const idx = room.players.findIndex((p) => p.key === key);
        if (idx !== -1) room.players.splice(idx, 1);

        // نظّف جاهزياته
        delete room.startReady[key];
        if (room.round.nextReady) delete room.round.nextReady[key];
        if (room.round.votes) delete room.round.votes[key];

        emitRoomUpdate(roomCode);

        io.to(roomCode).emit("start_round_progress", {
          readyCount: Object.keys(room.startReady).length,
          total: room.players.length,
        });

        if (room.round.phase === "results") {
          io.to(roomCode).emit("next_round_progress", {
            readyCount: Object.keys(room.round.nextReady || {}).length,
            total: room.players.length,
          });
        }

        delete room.disconnectTimers[key];

        if (room.players.length === 0) delete rooms[roomCode];
      }, 90 * 1000);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("Server running on port", PORT));
