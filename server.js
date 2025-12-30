const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const rooms = {};
// rooms[roomCode] = {
//   players: [{ id, name, score }],
//   startReady: { [playerId]: true },   // ✅ جاهزين لبدء الجولة
//   round: {
//     leaderId, outsiderId, topic,
//     phase: "idle" | "waiting_topic" | "discussion" | "voting" | "outsider_guess" | "results",
//     votes: { [voterId]: targetId },
//     voteOpen: boolean,
//     nextReady: { [playerId]: true }   // ✅ جاهزين للجولة القادمة
//   }
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
            round: {
                leaderId: null,
                outsiderId: null,
                topic: null,
                phase: "idle",
                votes: {},
                voteOpen: false,
                nextReady: {}
            }
        };
    }
    return rooms[roomCode];
}

function emitRoomUpdate(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    io.to(roomCode).emit("room_update", {
        players: room.players.map(p => ({ name: p.name, score: p.score }))
    });
}

function safePlayersList(room) {
    return room.players.map(p => ({ id: p.id, name: p.name }));
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

    room.startReady = {}; // ✅ صفّر جاهزية بدء الجولة (لأنها بدأت)

    room.round = {
        leaderId: leader.id,
        outsiderId: outsider.id,
        topic: null,
        phase: "waiting_topic",
        votes: {},
        voteOpen: false,
        nextReady: {}
    };

    io.to(roomCode).emit("round_started", { leaderName: leader.name });
    io.to(room.round.leaderId).emit("leader_prompt_topic");

    // صفّر عداد “جاهزين لبدء الجولة” عند الكل
    io.to(roomCode).emit("start_round_progress", { readyCount: 0, total: room.players.length });
}

function finishVoting(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.round.voteOpen = false;

    const counts = {};
    for (const voterId of Object.keys(room.round.votes)) {
        const targetId = room.round.votes[voterId];
        counts[targetId] = (counts[targetId] || 0) + 1;
    }

    let max = -1;
    let topIds = [];
    // المرشحين للتهمة: كل اللاعبين ما عدا المسؤول
const candidates = room.players.filter(
  p => p.id !== room.round.leaderId
);

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
    const outsiderCaught = (accusedId === outsiderId);

    if (outsiderCaught) {
        for (const voterId of Object.keys(room.round.votes)) {
            if (room.round.votes[voterId] === outsiderId) {
                const voter = room.players.find(p => p.id === voterId);
                if (voter) voter.score += 1;
            }
        }
    }

    const accused = room.players.find(p => p.id === accusedId);
    const outsider = room.players.find(p => p.id === outsiderId);

    room.round.phase = "outsider_guess";

    io.to(roomCode).emit("voting_result", {
        accusedName: accused?.name || "—",
        outsiderCaught,
        outsiderName: outsider?.name || "—"
    });

    io.to(outsiderId).emit("outsider_guess_prompt");
    emitRoomUpdate(roomCode);
}

io.on("connection", (socket) => {
    socket.on("join_room", ({ roomCode, name }) => {
        const room = getRoom(roomCode);

        const cleanName = (name || "").trim();
        if (!cleanName) {
            socket.emit("error_msg", "اكتب اسم صحيح");
            return;
        }

        const nameTaken = room.players.some(p => p.name === cleanName);
        if (nameTaken) {
            socket.emit("error_msg", "الاسم مستخدم داخل الغرفة، اختار اسم ثاني");
            return;
        }

        room.players.push({ id: socket.id, name: cleanName, score: 0 });
        socket.join(roomCode);

        // أي دخول جديد يلغي جاهزيات البدء/الجولة الجديدة لتجنب لخبطة العدادات
        room.startReady = {};
        room.round.nextReady = {};

        emitRoomUpdate(roomCode);

        io.to(roomCode).emit("start_round_progress", { readyCount: 0, total: room.players.length });
        io.to(roomCode).emit("next_round_progress", { readyCount: 0, total: room.players.length });
    });

    // ✅ جديد: جاهز لبدء الجولة (بدل بدء مباشر)
    socket.on("ready_start_round", ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;

        // ما نسمح ببدء جديد إذا الجولة شغالة (غير idle/results)
        const phase = room.round.phase;
        if (!(phase === "idle" || phase === "results")) {
            socket.emit("error_msg", "في جولة شغالة… ما بزبط تبدأ جولة جديدة الآن");
            return;
        }

        room.startReady[socket.id] = true;

        const readyCount = Object.keys(room.startReady).length;
        const total = room.players.length;

        io.to(roomCode).emit("start_round_progress", { readyCount, total });

        if (readyCount >= total) {
            room.startReady = {};
            startNewRoundInternal(roomCode);
        }
    });

    // المسؤول يرسل الموضوع
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

        room.players.forEach(p => {
            if (p.id === room.round.outsiderId) io.to(p.id).emit("topic_hidden");
            else io.to(p.id).emit("topic_revealed", { topic: safeTopic });
        });

        io.to(room.round.outsiderId).emit("you_are_outsider");
        room.players.forEach(p => {
            if (p.id !== room.round.outsiderId) io.to(p.id).emit("you_are_in");
        });

        io.to(roomCode).emit("discussion_ready");
        io.to(room.round.leaderId).emit("leader_topic_locked");
    });

    // فتح التصويت
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

  // ✅ القائمة بدون المسؤول
  const voteCandidates = room.players
    .filter(p => p.id !== room.round.leaderId)
    .map(p => ({ id: p.id, name: p.name }));

  io.to(roomCode).emit("voting_open", { players: voteCandidates });

  // ✅ اجمالي المصوتين (بدون المسؤول)
  const totalVoters = room.players.filter(p => p.id !== room.round.leaderId).length;
  io.to(roomCode).emit("vote_progress", { votedCount: 0, total: totalVoters });
});


    // إرسال صوت
   socket.on("submit_vote", ({ roomCode, targetId }) => {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.round.phase !== "voting" || !room.round.voteOpen) return;

  // ✅ المسؤول ممنوع يصوّت
  if (socket.id === room.round.leaderId) {
    socket.emit("error_msg", "المسؤول ما بصوّت");
    return;
  }

  // ✅ ممنوع تصوّت على حالك
  if (targetId === socket.id) {
    socket.emit("error_msg", "ما بزبط تصوّت لنفسك");
    return;
  }

  // ✅ ممنوع تصوّت على المسؤول (حتى لو حاول)
  if (targetId === room.round.leaderId) {
    socket.emit("error_msg", "ما بزبط تصوّت على المسؤول");
    return;
  }

  // تأكد الهدف موجود
  const target = room.players.find(p => p.id === targetId);
  if (!target) {
    socket.emit("error_msg", "اختيار غير صالح");
    return;
  }

  room.round.votes[socket.id] = targetId;

  // ✅ عدد المصوتين المطلوب (بدون المسؤول)
  const totalVoters = room.players.filter(p => p.id !== room.round.leaderId).length;

  io.to(roomCode).emit("vote_progress", {
    votedCount: Object.keys(room.round.votes).length,
    total: totalVoters
  });

  // ✅ انهي التصويت فقط لما كل غير المسؤول يصوّتوا
  if (Object.keys(room.round.votes).length === totalVoters) {
    finishVoting(roomCode);
  }
});


    socket.on("close_voting", ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;
        if (room.round.phase !== "voting") return;
        finishVoting(roomCode);
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
        const outsider = room.players.find(p => p.id === room.round.outsiderId);
        if (outsider && correct) outsider.score += 2;

        room.round.phase = "results";
        room.round.nextReady = {};

        io.to(roomCode).emit("round_results", {
            correct,
            topic: room.round.topic,
            scoreboard: room.players
                .map(p => ({ name: p.name, score: p.score }))
                .sort((a, b) => b.score - a.score)
        });

        emitRoomUpdate(roomCode);
    });

    // ✅ جاهز للجولة الجديدة (نتائج)
    socket.on("ready_next_round", ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;

        if (room.round.phase !== "results") {
            socket.emit("error_msg", "مش وقت جولة جديدة الآن");
            return;
        }

        if (!room.round.nextReady) room.round.nextReady = {};
        room.round.nextReady[socket.id] = true;

        const readyCount = Object.keys(room.round.nextReady).length;
        const total = room.players.length;

        io.to(roomCode).emit("next_round_progress", { readyCount, total });

        if (readyCount >= total) {
            room.round.nextReady = {};
            startNewRoundInternal(roomCode);
        }
    });

    socket.on("disconnect", () => {
        for (const roomCode of Object.keys(rooms)) {
            const room = rooms[roomCode];
            const before = room.players.length;

            room.players = room.players.filter(p => p.id !== socket.id);

            if (room.players.length === 0) {
                delete rooms[roomCode];
                continue;
            }

            // احذف جاهزيته من العدادات
            delete room.startReady[socket.id];
            if (room.round.nextReady) delete room.round.nextReady[socket.id];

            // تحديث العدادات
            io.to(roomCode).emit("start_round_progress", {
                readyCount: Object.keys(room.startReady).length,
                total: room.players.length
            });

            if (room.round.phase === "results") {
                io.to(roomCode).emit("next_round_progress", {
                    readyCount: Object.keys(room.round.nextReady || {}).length,
                    total: room.players.length
                });
            }

            // إذا خرج أثناء جولة شغالة نلغيها (تبسيط)
            if (before !== room.players.length && !(room.round.phase === "idle" || room.round.phase === "results")) {
                room.round.phase = "idle";
                room.round.votes = {};
                room.round.voteOpen = false;
                room.startReady = {};
                room.round.nextReady = {};
                io.to(roomCode).emit("error_msg", "حدا طلع من الغرفة… تم إلغاء الجولة. ابدأوا جولة جديدة.");
                io.to(roomCode).emit("start_round_progress", { readyCount: 0, total: room.players.length });
                io.to(roomCode).emit("next_round_progress", { readyCount: 0, total: room.players.length });
            }

            emitRoomUpdate(roomCode);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("Server running on port", PORT));


