import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getDatabase,
  get,
  onValue,
  push,
  ref,
  runTransaction,
  set
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = (selector) => document.querySelector(selector);
const els = {
  setupWarning: $("#setup-warning"),
  homeView: $("#home-view"),
  roomView: $("#room-view"),
  connectionPill: $("#connection-pill"),
  createForm: $("#create-form"),
  createName: $("#create-name"),
  startingStack: $("#starting-stack"),
  joinForm: $("#join-form"),
  joinName: $("#join-name"),
  joinCode: $("#join-code"),
  roomCode: $("#room-code"),
  roomTitle: $("#room-title"),
  copyRoom: $("#copy-room"),
  leaveRoom: $("#leave-room"),
  potValue: $("#pot-value"),
  handLabel: $("#hand-label"),
  myBalance: $("#my-balance"),
  myNameLabel: $("#my-name-label"),
  turnHeading: $("#turn-heading"),
  turnPill: $("#turn-pill"),
  actionNote: $("#action-note"),
  actionCheck: $("#action-check"),
  actionCall: $("#action-call"),
  actionFold: $("#action-fold"),
  actionAllIn: $("#action-all-in"),
  raiseTarget: $("#raise-target"),
  raiseLabel: $("#raise-label"),
  actionRaise: $("#action-raise"),
  donatePlayer: $("#donate-player"),
  donateAmount: $("#donate-amount"),
  donateButton: $("#donate-button"),
  playerCount: $("#player-count"),
  playersList: $("#players-list"),
  hostPanel: $("#host-panel"),
  turnOrderList: $("#turn-order-list"),
  hostPlayer: $("#host-player"),
  hostAmount: $("#host-amount"),
  hostAdd: $("#host-add"),
  hostRemove: $("#host-remove"),
  hostNextRound: $("#host-next-round"),
  sidePotsPreview: $("#side-pots-preview"),
  showdownRanks: $("#showdown-ranks"),
  hostSettle: $("#host-settle"),
  hostNextHand: $("#host-next-hand"),
  activityList: $("#activity-list"),
  toast: $("#toast")
};

let auth;
let db;
let currentUser = null;
let currentRoomCode = null;
let currentRoom = null;
let unsubscribeRoom = null;
let toastTimer = null;

const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function isFirebaseConfigured() {
  return Boolean(
    firebaseConfig?.apiKey &&
    !String(firebaseConfig.apiKey).includes("PASTE_") &&
    firebaseConfig?.databaseURL &&
    !String(firebaseConfig.databaseURL).includes("PASTE_")
  );
}

function formatChips(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function cleanName(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, 24);
}

function cleanCode(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function intValue(value, fallback = 0) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 3000);
}

function setBusy(button, busy) {
  if (button) button.disabled = busy;
}

function setView(roomMode) {
  els.homeView.classList.toggle("hidden", roomMode);
  els.roomView.classList.toggle("hidden", !roomMode);
}

function generateRoomCode() {
  let code = "";
  const values = new Uint32Array(6);
  crypto.getRandomValues(values);
  for (const value of values) code += ROOM_CHARS[value % ROOM_CHARS.length];
  return code;
}

async function uniqueRoomCode() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateRoomCode();
    const snap = await get(ref(db, `rooms/${code}`));
    if (!snap.exists()) return code;
  }
  throw new Error("Could not generate a unique room code. Try again.");
}

function inviteUrl(code = currentRoomCode) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", code);
  return url.toString();
}

function setRoomInUrl(code) {
  const url = new URL(window.location.href);
  if (code) url.searchParams.set("room", code);
  else url.searchParams.delete("room");
  history.pushState({}, "", url);
}

async function ensureSignedIn() {
  if (currentUser) return currentUser;
  const credential = await signInAnonymously(auth);
  currentUser = credential.user;
  return currentUser;
}

async function logActivity(text) {
  if (!currentRoomCode || !currentUser) return;
  try {
    await push(ref(db, `rooms/${currentRoomCode}/activity`), {
      text: String(text).slice(0, 180),
      at: Date.now(),
      actorId: currentUser.uid
    });
  } catch (error) {
    console.warn("Activity log failed:", error);
  }
}

function playerEntries(room) {
  return Object.entries(room.players || {}).map(([id, player]) => ({ id, ...player }));
}

function orderedIds(room) {
  const ids = playerEntries(room)
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))
    .map((player) => player.id);
  const stored = Array.isArray(room.turnOrder) ? room.turnOrder.filter((id) => ids.includes(id)) : [];
  return [...stored, ...ids.filter((id) => !stored.includes(id))];
}

function ensureGameState(room) {
  if (!room.players) room.players = {};
  room.turnOrder = orderedIds(room);
  room.pot = intValue(room.pot);
  room.handNumber = Math.max(1, intValue(room.handNumber, 1));
  room.handSettled = Boolean(room.handSettled);
  if (!room.round || typeof room.round !== "object") room.round = {};
  room.round.status = ["waiting", "active", "complete"].includes(room.round.status) ? room.round.status : "waiting";
  room.round.actingId = room.round.actingId || null;
  room.round.starterId = room.round.starterId || null;
  room.round.currentBet = Math.max(0, intValue(room.round.currentBet));
  room.round.lastFullRaise = Math.max(0, intValue(room.round.lastFullRaise));
  room.round.pendingIds = Array.isArray(room.round.pendingIds) ? room.round.pendingIds : [];
  room.round.raiseBlockedIds = Array.isArray(room.round.raiseBlockedIds) ? room.round.raiseBlockedIds : [];

  for (const player of Object.values(room.players)) {
    player.balance = Math.max(0, intValue(player.balance));
    player.handCommitted = Math.max(0, intValue(player.handCommitted));
    player.roundCommitted = Math.max(0, intValue(player.roundCommitted));
    if (typeof player.inHand !== "boolean") player.inHand = true;
    player.folded = Boolean(player.folded);
    player.allIn = Boolean(player.allIn || (player.inHand && player.balance === 0 && player.handCommitted > 0));
  }
  return room;
}

function playerCanAct(player) {
  return Boolean(player?.inHand && !player.folded && !player.allIn && Number(player.balance) > 0);
}

function playerCanWin(player) {
  return Boolean(player?.inHand && !player.folded);
}

function activeHandIds(room) {
  return orderedIds(room).filter((id) => room.players?.[id]?.inHand);
}

function liveHandIds(room) {
  return activeHandIds(room).filter((id) => !room.players[id].folded);
}

function nextIdFromOrder(room, afterId, allowedIds) {
  const order = orderedIds(room);
  const allowed = new Set(allowedIds);
  if (!order.length || !allowed.size) return null;
  let start = Math.max(0, order.indexOf(afterId));
  if (order.indexOf(afterId) < 0) start = order.length - 1;
  for (let step = 1; step <= order.length; step++) {
    const id = order[(start + step) % order.length];
    if (allowed.has(id)) return id;
  }
  return null;
}

function finishOrAdvance(room, actorId, pendingIds) {
  const live = liveHandIds(room);
  if (live.length <= 1) {
    room.round.status = "complete";
    room.round.actingId = null;
    room.round.pendingIds = [];
    return;
  }

  const filtered = [...new Set(pendingIds)].filter((id) => playerCanAct(room.players[id]));
  room.round.pendingIds = filtered;
  if (!filtered.length) {
    room.round.status = "complete";
    room.round.actingId = null;
    return;
  }
  room.round.status = "active";
  room.round.actingId = nextIdFromOrder(room, actorId, filtered);
}

function putIntoPot(room, player, amount) {
  const chips = Math.max(0, intValue(amount));
  if (chips > player.balance) return false;
  player.balance -= chips;
  player.handCommitted += chips;
  player.roundCommitted += chips;
  room.pot += chips;
  if (player.balance === 0) player.allIn = true;
  return true;
}

function sidePots(room) {
  const players = playerEntries(room).filter((p) => intValue(p.handCommitted) > 0);
  const levels = [...new Set(players.map((p) => intValue(p.handCommitted)))].sort((a, b) => a - b);
  const pots = [];
  let previous = 0;
  for (const level of levels) {
    const contributors = players.filter((p) => intValue(p.handCommitted) >= level);
    const amount = (level - previous) * contributors.length;
    if (amount > 0) {
      pots.push({
        amount,
        cap: level,
        contributorIds: contributors.map((p) => p.id),
        eligibleIds: contributors.filter((p) => playerCanWin(room.players[p.id])).map((p) => p.id)
      });
    }
    previous = level;
  }
  return pots;
}

function potLabel(index) {
  return index === 0 ? "Main pot" : `Side pot ${index}`;
}

function renderPlayers(room) {
  const order = orderedIds(room);
  const players = order.map((id) => ({ id, ...room.players[id] }));
  els.playerCount.textContent = `${players.length} player${players.length === 1 ? "" : "s"}`;
  els.playersList.replaceChildren();

  for (const [index, player] of players.entries()) {
    const row = document.createElement("div");
    row.className = "player-row";
    if (room.round?.actingId === player.id) row.classList.add("is-turn");
    if (player.folded) row.classList.add("is-folded");

    const nameWrap = document.createElement("div");
    nameWrap.className = "player-main";
    const position = document.createElement("span");
    position.className = "seat-number";
    position.textContent = String(index + 1);
    const textWrap = document.createElement("div");
    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = player.name || "Player";
    textWrap.appendChild(name);

    const tags = document.createElement("span");
    tags.className = "player-tags";
    if (player.id === currentUser?.uid) tags.appendChild(makeMiniTag("you"));
    if (player.id === room.hostId) tags.appendChild(makeMiniTag("host"));
    if (!player.inHand) tags.appendChild(makeMiniTag("next hand"));
    else if (player.folded) tags.appendChild(makeMiniTag("folded"));
    else if (player.allIn) tags.appendChild(makeMiniTag("all in"));
    if (room.round?.actingId === player.id) tags.appendChild(makeMiniTag("turn", "turn-tag"));
    textWrap.appendChild(tags);
    nameWrap.append(position, textWrap);

    const numbers = document.createElement("div");
    numbers.className = "player-numbers";
    const balance = document.createElement("strong");
    balance.className = "player-balance";
    balance.textContent = formatChips(player.balance);
    const committed = document.createElement("span");
    committed.className = "player-committed";
    committed.textContent = player.handCommitted ? `${formatChips(player.handCommitted)} in pot` : "";
    numbers.append(balance, committed);

    row.append(nameWrap, numbers);
    els.playersList.appendChild(row);
  }

  renderPlayerSelects(players);
}

function renderPlayerSelects(players) {
  const hostSelected = els.hostPlayer.value;
  els.hostPlayer.replaceChildren();
  for (const player of players) {
    const option = document.createElement("option");
    option.value = player.id;
    option.textContent = `${player.name || "Player"} — ${formatChips(player.balance)}`;
    els.hostPlayer.appendChild(option);
  }
  if (players.some((p) => p.id === hostSelected)) els.hostPlayer.value = hostSelected;

  const donateSelected = els.donatePlayer.value;
  els.donatePlayer.replaceChildren();
  const recipients = players.filter((p) => p.id !== currentUser?.uid);
  if (!recipients.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No other players";
    els.donatePlayer.appendChild(option);
  } else {
    for (const player of recipients) {
      const option = document.createElement("option");
      option.value = player.id;
      option.textContent = player.name || "Player";
      els.donatePlayer.appendChild(option);
    }
    if (recipients.some((p) => p.id === donateSelected)) els.donatePlayer.value = donateSelected;
  }
}

function makeMiniTag(text, extraClass = "") {
  const tag = document.createElement("span");
  tag.className = `mini-tag ${extraClass}`.trim();
  tag.textContent = text;
  return tag;
}

function renderActivity(room) {
  const entries = Object.values(room.activity || {})
    .filter((item) => item && item.text)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, 16);

  els.activityList.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No actions yet.";
    els.activityList.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = "activity-item";
    const text = document.createElement("span");
    text.textContent = entry.text;
    const time = document.createElement("time");
    time.className = "activity-time";
    time.textContent = entry.at ? new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    item.append(text, time);
    els.activityList.appendChild(item);
  }
}

function renderActionControls(room) {
  const me = room.players?.[currentUser?.uid];
  const round = room.round;
  const waiting = round.status === "waiting";
  const isMyTurn = round.status === "active" && round.actingId === currentUser?.uid;
  const canOpen = waiting && playerCanAct(me) && !room.handSettled;
  const canAct = canOpen || isMyTurn;
  const toCall = me ? Math.max(0, intValue(round.currentBet) - intValue(me.roundCommitted)) : 0;
  const blockedFromRaising = round.raiseBlockedIds?.includes(currentUser?.uid);
  const actingName = room.players?.[round.actingId]?.name || "Player";

  if (room.handSettled) {
    els.turnHeading.textContent = "Hand settled";
    els.turnPill.textContent = "Done";
    els.actionNote.textContent = "The host can start the next hand.";
  } else if (!me?.inHand) {
    els.turnHeading.textContent = "Sitting out this hand";
    els.turnPill.textContent = "Next hand";
    els.actionNote.textContent = "You joined after this hand started and will be included in the next hand.";
  } else if (round.status === "complete") {
    els.turnHeading.textContent = "Betting round complete";
    els.turnPill.textContent = "Complete";
    els.actionNote.textContent = "The host can start another betting round or settle the pots at showdown.";
  } else if (waiting) {
    els.turnHeading.textContent = "Open the action";
    els.turnPill.textContent = "Open";
    els.actionNote.textContent = "Any active player may act first. After that, turns advance through the host’s table order.";
  } else if (isMyTurn) {
    els.turnHeading.textContent = "Your turn";
    els.turnPill.textContent = "Act now";
    els.actionNote.textContent = toCall > 0
      ? `You need ${formatChips(toCall)} to call the current bet of ${formatChips(round.currentBet)}.`
      : `You have matched the current bet of ${formatChips(round.currentBet)}.`;
  } else {
    els.turnHeading.textContent = `${actingName}'s turn`;
    els.turnPill.textContent = "Waiting";
    els.actionNote.textContent = `Action will move automatically after ${actingName} acts.`;
  }

  els.actionCheck.disabled = !(canAct && toCall === 0);
  els.actionFold.disabled = !canAct;
  els.actionCall.disabled = !(canAct && toCall > 0);
  els.actionCall.textContent = toCall > 0 && me
    ? `${me.balance <= toCall ? "Call all-in" : "Call"} ${formatChips(Math.min(toCall, me.balance))}`
    : "Call";

  const canRaise = canAct && me && me.balance > toCall && !blockedFromRaising;
  els.raiseTarget.disabled = !canRaise;
  els.actionRaise.disabled = !canRaise;
  els.actionAllIn.disabled = !(canAct && me && me.balance > 0 && (!blockedFromRaising || me.balance <= toCall));
  els.actionAllIn.textContent = me?.balance > 0 ? `All in ${formatChips(me.balance)}` : "All in";

  if (round.currentBet > 0) {
    els.raiseLabel.textContent = "Raise to (total this round)";
    els.raiseTarget.placeholder = `More than ${formatChips(round.currentBet)}`;
    els.actionRaise.textContent = "Raise";
  } else {
    els.raiseLabel.textContent = "Bet amount";
    els.raiseTarget.placeholder = "Bet amount";
    els.actionRaise.textContent = "Bet";
  }

  if (blockedFromRaising && canAct && me?.balance > toCall) {
    els.actionNote.textContent += " A short all-in did not reopen raising for you; you may call or fold.";
  }
}

function renderTurnOrder(room) {
  els.turnOrderList.replaceChildren();
  const order = orderedIds(room);
  order.forEach((id, index) => {
    const player = room.players[id];
    const row = document.createElement("div");
    row.className = "turn-order-row";
    const label = document.createElement("div");
    label.className = "turn-order-name";
    label.textContent = `${index + 1}. ${player?.name || "Player"}`;
    const controls = document.createElement("div");
    controls.className = "order-buttons";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "button ghost icon-button";
    up.textContent = "↑";
    up.title = "Move earlier";
    up.disabled = index === 0;
    up.addEventListener("click", () => movePlayerInOrder(id, -1, up));
    const down = document.createElement("button");
    down.type = "button";
    down.className = "button ghost icon-button";
    down.textContent = "↓";
    down.title = "Move later";
    down.disabled = index === order.length - 1;
    down.addEventListener("click", () => movePlayerInOrder(id, 1, down));
    controls.append(up, down);
    row.append(label, controls);
    els.turnOrderList.appendChild(row);
  });
}

function renderSidePots(room) {
  const pots = sidePots(room);
  els.sidePotsPreview.replaceChildren();
  if (!pots.length) {
    const empty = document.createElement("p");
    empty.className = "microcopy";
    empty.textContent = "No chips have been committed yet.";
    els.sidePotsPreview.appendChild(empty);
    return;
  }
  pots.forEach((pot, index) => {
    const item = document.createElement("div");
    item.className = "pot-preview-row";
    const left = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = potLabel(index);
    const eligible = document.createElement("span");
    eligible.textContent = `Eligible: ${pot.eligibleIds.map((id) => room.players[id]?.name || "Player").join(", ") || "none"}`;
    left.append(title, eligible);
    const amount = document.createElement("strong");
    amount.textContent = formatChips(pot.amount);
    item.append(left, amount);
    els.sidePotsPreview.appendChild(item);
  });
}

function renderShowdownRanks(room) {
  const previous = {};
  els.showdownRanks.querySelectorAll("input[data-player-id]").forEach((input) => {
    previous[input.dataset.playerId] = input.value;
  });
  els.showdownRanks.replaceChildren();
  const players = orderedIds(room)
    .map((id) => ({ id, ...room.players[id] }))
    .filter((player) => player.inHand && player.handCommitted > 0);

  if (!players.length) {
    const empty = document.createElement("p");
    empty.className = "microcopy";
    empty.textContent = "Places appear here once players put chips in the pot.";
    els.showdownRanks.appendChild(empty);
    return;
  }

  for (const player of players) {
    const row = document.createElement("label");
    row.className = "rank-row";
    const name = document.createElement("span");
    name.textContent = player.name || "Player";
    const detail = document.createElement("span");
    detail.className = "rank-detail";
    detail.textContent = player.folded ? `Folded · ${formatChips(player.handCommitted)} committed` : `${formatChips(player.handCommitted)} committed`;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.inputMode = "numeric";
    input.placeholder = player.folded ? "—" : "Place";
    input.disabled = player.folded;
    input.dataset.playerId = player.id;
    input.setAttribute("aria-label", `${player.name || "Player"} finishing place`);
    if (previous[player.id]) input.value = previous[player.id];
    const text = document.createElement("div");
    text.append(name, detail);
    row.append(text, input);
    els.showdownRanks.appendChild(row);
  }
}

function renderHost(room, isHost) {
  els.hostPanel.classList.toggle("hidden", !isHost);
  if (!isHost) return;
  renderTurnOrder(room);
  renderSidePots(room);
  renderShowdownRanks(room);
  const actorsRemaining = orderedIds(room).filter((id) => playerCanAct(room.players[id])).length;
  els.hostNextRound.disabled = room.handSettled || room.round.status !== "complete" || actorsRemaining < 2;
  els.hostSettle.disabled = room.pot <= 0 || room.handSettled;
  els.hostNextHand.disabled = room.pot !== 0 || !room.handSettled;
}

function renderRoom(rawRoom) {
  const room = ensureGameState(structuredClone(rawRoom));
  currentRoom = room;
  const me = room.players?.[currentUser?.uid];
  const isHost = room.hostId === currentUser?.uid;

  els.roomCode.textContent = currentRoomCode;
  els.roomTitle.textContent = isHost ? "Your game" : `${room.players?.[room.hostId]?.name || "Host"}'s game`;
  els.potValue.textContent = formatChips(room.pot);
  els.handLabel.textContent = `Hand ${room.handNumber || 1}`;
  els.myBalance.textContent = formatChips(me?.balance || 0);
  els.myNameLabel.textContent = me?.name || "Spectating";

  renderActionControls(room);
  renderPlayers(room);
  renderHost(room, isHost);
  renderActivity(room);

  const donationWindow = room.handSettled || (room.pot === 0 && !room.round.starterId && playerEntries(room).every((p) => !p.handCommitted));
  els.donateButton.disabled = !me || me.balance <= 0 || !els.donatePlayer.value || !donationWindow;
}

async function enterRoom(code) {
  currentRoomCode = code;
  setRoomInUrl(code);
  setView(true);
  if (unsubscribeRoom) unsubscribeRoom();

  unsubscribeRoom = onValue(ref(db, `rooms/${code}`), (snapshot) => {
    if (!snapshot.exists()) {
      showToast("That table no longer exists.");
      leaveRoom();
      return;
    }
    renderRoom(snapshot.val());
  }, (error) => {
    console.error(error);
    showToast("Could not sync this table.");
  });
}

function leaveRoom() {
  if (unsubscribeRoom) unsubscribeRoom();
  unsubscribeRoom = null;
  currentRoomCode = null;
  currentRoom = null;
  setRoomInUrl(null);
  setView(false);
}

function freshRound() {
  return {
    status: "waiting",
    actingId: null,
    starterId: null,
    currentBet: 0,
    lastFullRaise: 0,
    pendingIds: [],
    raiseBlockedIds: []
  };
}

async function createRoom(event) {
  event.preventDefault();
  const button = event.submitter;
  const name = cleanName(els.createName.value);
  const startingStack = intValue(els.startingStack.value);
  if (!name) return showToast("Enter your name.");
  if (startingStack < 1) return showToast("Choose a valid starting stack.");

  setBusy(button, true);
  try {
    await ensureSignedIn();
    const code = await uniqueRoomCode();
    const room = {
      hostId: currentUser.uid,
      createdAt: Date.now(),
      startingStack,
      pot: 0,
      handNumber: 1,
      handSettled: false,
      turnOrder: [currentUser.uid],
      round: freshRound(),
      players: {
        [currentUser.uid]: {
          name,
          balance: startingStack,
          joinedAt: Date.now(),
          handCommitted: 0,
          roundCommitted: 0,
          inHand: true,
          folded: false,
          allIn: false
        }
      }
    };
    await set(ref(db, `rooms/${code}`), room);
    localStorage.setItem("pocketChipsName", name);
    await enterRoom(code);
    await logActivity(`${name} created the table.`);
  } catch (error) {
    console.error(error);
    showToast(error?.message || "Could not create the table.");
  } finally {
    setBusy(button, false);
  }
}

async function joinRoom(event) {
  event.preventDefault();
  const button = event.submitter;
  const name = cleanName(els.joinName.value);
  const code = cleanCode(els.joinCode.value);
  if (!name) return showToast("Enter your name.");
  if (code.length !== 6) return showToast("Enter the 6-character room code.");

  setBusy(button, true);
  try {
    await ensureSignedIn();
    const roomRef = ref(db, `rooms/${code}`);
    const roomSnap = await get(roomRef);
    if (!roomSnap.exists()) throw new Error("Room not found. Check the code and try again.");
    const snapshotRoom = ensureGameState(roomSnap.val());
    const existing = snapshotRoom.players?.[currentUser.uid];
    if (!existing) {
      let joinedInHand = true;
      const result = await runTransaction(roomRef, (room) => {
        if (!room) return;
        ensureGameState(room);
        if (room.players[currentUser.uid]) return room;
        const handStarted = Boolean(room.round.starterId || room.pot > 0 || room.handSettled);
        joinedInHand = !handStarted;
        room.players[currentUser.uid] = {
          name,
          balance: Number(room.startingStack),
          joinedAt: Date.now(),
          handCommitted: 0,
          roundCommitted: 0,
          inHand: joinedInHand,
          folded: false,
          allIn: false
        };
        room.turnOrder = orderedIds(room);
        return room;
      });
      if (!result.committed) throw new Error("Could not join the room.");
      currentRoomCode = code;
      await logActivity(`${name} joined with ${formatChips(snapshotRoom.startingStack)} chips${joinedInHand ? "." : " and will enter next hand."}`);
    } else if (existing.name !== name) {
      await set(ref(db, `rooms/${code}/players/${currentUser.uid}/name`), name);
    }
    localStorage.setItem("pocketChipsName", name);
    await enterRoom(code);
  } catch (error) {
    console.error(error);
    showToast(error?.message || "Could not join the table.");
  } finally {
    setBusy(button, false);
  }
}

async function performPokerAction(type, rawTarget = null, button = null) {
  if (!currentRoomCode || !currentUser) return;
  setBusy(button, true);
  let message = "";
  let failure = "That action is not available right now.";

  try {
    const result = await runTransaction(ref(db, `rooms/${currentRoomCode}`), (room) => {
      if (!room?.players?.[currentUser.uid]) return;
      ensureGameState(room);
      if (room.handSettled) return;
      const player = room.players[currentUser.uid];
      if (!playerCanAct(player)) return;
      const round = room.round;
      const opening = round.status === "waiting";
      if (!opening && (round.status !== "active" || round.actingId !== currentUser.uid)) return;

      const name = player.name || "Player";
      const oldCurrentBet = intValue(round.currentBet);
      const toCall = Math.max(0, oldCurrentBet - intValue(player.roundCommitted));
      const pendingBefore = Array.isArray(round.pendingIds) ? [...round.pendingIds] : [];
      let aggressive = false;
      let fullRaise = false;
      let shortAllInRaise = false;

      if (type === "check") {
        if (toCall !== 0) {
          failure = `You need ${formatChips(toCall)} to call; you cannot check.`;
          return;
        }
        message = `${name} checked.`;
      } else if (type === "fold") {
        player.folded = true;
        message = `${name} folded.`;
      } else if (type === "call") {
        if (toCall <= 0) {
          failure = "There is nothing to call.";
          return;
        }
        const amount = Math.min(toCall, player.balance);
        if (!putIntoPot(room, player, amount)) return;
        message = amount < toCall
          ? `${name} called all-in for ${formatChips(amount)}.`
          : `${name} called ${formatChips(amount)}.`;
      } else if (type === "raise") {
        if (round.raiseBlockedIds.includes(currentUser.uid)) {
          failure = "Raising has not been reopened for you after the short all-in.";
          return;
        }
        const target = intValue(rawTarget);
        const maximumTarget = player.roundCommitted + player.balance;
        if (target <= oldCurrentBet || target <= player.roundCommitted) {
          failure = oldCurrentBet > 0
            ? `Raise to more than ${formatChips(oldCurrentBet)}.`
            : "Enter a positive bet amount.";
          return;
        }
        if (target > maximumTarget) {
          failure = `Your maximum is ${formatChips(maximumTarget)}.`;
          return;
        }
        const amount = target - player.roundCommitted;
        const raiseSize = target - oldCurrentBet;
        const isAllIn = amount === player.balance;
        const minimumRaise = oldCurrentBet === 0 ? 1 : Math.max(1, round.lastFullRaise || oldCurrentBet);
        if (oldCurrentBet > 0 && raiseSize < minimumRaise && !isAllIn) {
          failure = `Minimum raise is to ${formatChips(oldCurrentBet + minimumRaise)}.`;
          return;
        }
        if (!putIntoPot(room, player, amount)) return;
        aggressive = true;
        fullRaise = oldCurrentBet === 0 || raiseSize >= minimumRaise;
        shortAllInRaise = !fullRaise && isAllIn;
        round.currentBet = target;
        if (fullRaise) round.lastFullRaise = oldCurrentBet === 0 ? target : raiseSize;
        message = oldCurrentBet === 0
          ? `${name} bet ${formatChips(target)}${player.allIn ? " all-in" : ""}.`
          : `${name} raised to ${formatChips(target)}${player.allIn ? " all-in" : ""}.`;
      } else if (type === "allin") {
        if (player.balance <= 0) return;
        const target = player.roundCommitted + player.balance;
        if (round.raiseBlockedIds.includes(currentUser.uid) && target > oldCurrentBet) {
          failure = "You can call or fold, but this short all-in did not reopen raising for you.";
          return;
        }
        const amount = player.balance;
        if (!putIntoPot(room, player, amount)) return;
        if (target > oldCurrentBet) {
          aggressive = true;
          const raiseSize = target - oldCurrentBet;
          const minimumRaise = oldCurrentBet === 0 ? 1 : Math.max(1, round.lastFullRaise || oldCurrentBet);
          fullRaise = oldCurrentBet === 0 || raiseSize >= minimumRaise;
          shortAllInRaise = !fullRaise;
          round.currentBet = target;
          if (fullRaise) round.lastFullRaise = oldCurrentBet === 0 ? target : raiseSize;
          message = oldCurrentBet === 0
            ? `${name} bet all-in for ${formatChips(target)}.`
            : `${name} raised all-in to ${formatChips(target)}.`;
        } else {
          message = `${name} called all-in for ${formatChips(amount)}.`;
        }
      } else {
        return;
      }

      if (opening) {
        round.starterId = currentUser.uid;
        round.status = "active";
      }

      const otherActors = orderedIds(room).filter((id) => id !== currentUser.uid && playerCanAct(room.players[id]));
      let nextPending;
      if (aggressive && fullRaise) {
        round.raiseBlockedIds = [];
        nextPending = otherActors;
      } else if (aggressive && shortAllInRaise) {
        const alreadyActed = otherActors.filter((id) => !pendingBefore.includes(id));
        round.raiseBlockedIds = [...new Set([...round.raiseBlockedIds, ...alreadyActed])];
        nextPending = otherActors.filter((id) => room.players[id].roundCommitted < round.currentBet);
      } else if (opening) {
        nextPending = otherActors;
      } else {
        nextPending = pendingBefore.filter((id) => id !== currentUser.uid);
      }

      finishOrAdvance(room, currentUser.uid, nextPending);
      return room;
    });

    if (!result.committed) return showToast(failure);
    els.raiseTarget.value = "";
    await logActivity(message);
  } catch (error) {
    console.error(error);
    showToast("That action could not be recorded.");
  } finally {
    setBusy(button, false);
  }
}

async function donateChips(button) {
  if (!currentRoomCode || !currentUser) return;
  const recipientId = els.donatePlayer.value;
  const amount = intValue(els.donateAmount.value);
  if (!recipientId || recipientId === currentUser.uid) return showToast("Choose another player.");
  if (amount <= 0) return showToast("Enter a valid donation amount.");
  setBusy(button, true);
  let message = "";
  try {
    const result = await runTransaction(ref(db, `rooms/${currentRoomCode}`), (room) => {
      if (!room?.players?.[currentUser.uid] || !room.players?.[recipientId]) return;
      ensureGameState(room);
      const donor = room.players[currentUser.uid];
      const recipient = room.players[recipientId];
      const donationWindow = room.handSettled || (room.pot === 0 && !room.round.starterId && Object.values(room.players).every((p) => !intValue(p.handCommitted)));
      if (!donationWindow) return;
      if (amount > donor.balance) return;
      donor.balance -= amount;
      recipient.balance += amount;
      if (donor.balance === 0 && donor.inHand && donor.handCommitted > 0) donor.allIn = true;
      if (recipient.balance > 0 && recipient.allIn && recipient.handCommitted === 0) recipient.allIn = false;
      message = `${donor.name || "Player"} donated ${formatChips(amount)} chips to ${recipient.name || "Player"}.`;
      return room;
    });
    if (!result.committed) return showToast("Donate between hands or before action starts, and only from chips in your stack.");
    els.donateAmount.value = "";
    await logActivity(message);
  } catch (error) {
    console.error(error);
    showToast("Could not transfer those chips.");
  } finally {
    setBusy(button, false);
  }
}

async function movePlayerInOrder(playerId, direction, button) {
  if (!currentRoomCode || currentRoom?.hostId !== currentUser?.uid) return;
  setBusy(button, true);
  try {
    const result = await runTransaction(ref(db, `rooms/${currentRoomCode}`), (room) => {
      if (!room || room.hostId !== currentUser.uid) return;
      ensureGameState(room);
      const order = orderedIds(room);
      const index = order.indexOf(playerId);
      const swapIndex = index + direction;
      if (index < 0 || swapIndex < 0 || swapIndex >= order.length) return;
      [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
      room.turnOrder = order;
      return room;
    });
    if (!result.committed) return;
  } catch (error) {
    console.error(error);
    showToast("Could not change the turn order.");
  } finally {
    setBusy(button, false);
  }
}

async function hostAdjust(direction, button) {
  if (!currentRoomCode || !currentRoom || currentRoom.hostId !== currentUser?.uid) return;
  const playerId = els.hostPlayer.value;
  const amount = intValue(els.hostAmount.value);
  if (!playerId || amount <= 0) return showToast("Choose a player and valid amount.");

  setBusy(button, true);
  let playerName = "Player";
  try {
    const result = await runTransaction(ref(db, `rooms/${currentRoomCode}`), (room) => {
      if (!room || room.hostId !== currentUser.uid || !room.players?.[playerId]) return;
      ensureGameState(room);
      const player = room.players[playerId];
      const next = player.balance + direction * amount;
      if (next < 0) return;
      playerName = player.name || "Player";
      player.balance = next;
      if (next > 0 && player.allIn && player.handCommitted === 0) player.allIn = false;
      return room;
    });
    if (!result.committed) return showToast("That adjustment would make the stack negative.");
    await logActivity(`${direction > 0 ? "Added" : "Removed"} ${formatChips(amount)} chips ${direction > 0 ? "to" : "from"} ${playerName}.`);
  } catch (error) {
    console.error(error);
    showToast("Could not adjust that stack.");
  } finally {
    setBusy(button, false);
  }
}

async function nextBettingRound(button) {
  if (!currentRoomCode || currentRoom?.hostId !== currentUser?.uid) return;
  setBusy(button, true);
  try {
    const result = await runTransaction(ref(db, `rooms/${currentRoomCode}`), (room) => {
      if (!room || room.hostId !== currentUser.uid) return;
      ensureGameState(room);
      const actorsRemaining = orderedIds(room).filter((id) => playerCanAct(room.players[id])).length;
      if (room.handSettled || room.round.status !== "complete" || actorsRemaining < 2) return;
      for (const player of Object.values(room.players)) player.roundCommitted = 0;
      room.round = freshRound();
      return room;
    });
    if (!result.committed) return showToast("Finish the current betting round first.");
    await logActivity("Started the next betting round.");
  } catch (error) {
    console.error(error);
    showToast("Could not start the next betting round.");
  } finally {
    setBusy(button, false);
  }
}

function readRanks() {
  const ranks = {};
  els.showdownRanks.querySelectorAll("input[data-player-id]:not(:disabled)").forEach((input) => {
    const rank = intValue(input.value);
    if (rank > 0) ranks[input.dataset.playerId] = rank;
  });
  return ranks;
}

async function settlePots(button) {
  if (!currentRoomCode || currentRoom?.hostId !== currentUser?.uid) return;
  const ranks = readRanks();
  setBusy(button, true);
  let summary = "";
  let failure = "Enter enough finishing places to determine every pot winner.";

  try {
    const result = await runTransaction(ref(db, `rooms/${currentRoomCode}`), (room) => {
      if (!room || room.hostId !== currentUser.uid) return;
      ensureGameState(room);
      if (room.handSettled || room.pot <= 0) {
        failure = "There is no unsettled pot.";
        return;
      }
      const pots = sidePots(room);
      const requiredRanks = playerEntries(room).filter((p) => p.inHand && !p.folded && p.handCommitted > 0).map((p) => p.id);
      if (requiredRanks.some((id) => !ranks[id])) {
        failure = "Enter a finishing place for every non-folded player who has chips in the pot.";
        return;
      }
      const tracked = pots.reduce((sum, pot) => sum + pot.amount, 0);
      if (tracked !== room.pot) {
        failure = "The pot does not match tracked hand contributions. Start a fresh hand before using automatic settlement.";
        return;
      }

      const awards = {};
      const descriptions = [];
      const order = orderedIds(room);
      for (const [index, pot] of pots.entries()) {
        const rankedEligible = pot.eligibleIds.filter((id) => ranks[id] > 0);
        if (!rankedEligible.length) {
          failure = `${potLabel(index)} still needs a ranked eligible player.`;
          return;
        }
        const bestRank = Math.min(...rankedEligible.map((id) => ranks[id]));
        const winners = pot.eligibleIds
          .filter((id) => ranks[id] === bestRank)
          .sort((a, b) => order.indexOf(a) - order.indexOf(b));
        if (!winners.length) return;
        const share = Math.floor(pot.amount / winners.length);
        let remainder = pot.amount % winners.length;
        for (const id of winners) {
          const extra = remainder > 0 ? 1 : 0;
          remainder -= extra;
          awards[id] = (awards[id] || 0) + share + extra;
        }
        descriptions.push(`${potLabel(index)} ${formatChips(pot.amount)} → ${winners.map((id) => room.players[id]?.name || "Player").join(" / ")}`);
      }

      for (const [id, amount] of Object.entries(awards)) {
        if (!room.players[id]) return;
        room.players[id].balance += amount;
      }
      room.pot = 0;
      room.handSettled = true;
      room.round.status = "complete";
      room.round.actingId = null;
      room.round.pendingIds = [];
      summary = descriptions.join("; ");
      return room;
    });

    if (!result.committed) return showToast(failure);
    await logActivity(`Pots settled. ${summary}`);
    showToast("Pots settled automatically.");
  } catch (error) {
    console.error(error);
    showToast("Could not settle the pots.");
  } finally {
    setBusy(button, false);
  }
}

async function nextHand(button) {
  if (!currentRoomCode || currentRoom?.hostId !== currentUser?.uid) return;
  setBusy(button, true);
  let handNumber = 0;
  try {
    const result = await runTransaction(ref(db, `rooms/${currentRoomCode}`), (room) => {
      if (!room || room.hostId !== currentUser.uid) return;
      ensureGameState(room);
      if (room.pot !== 0 || !room.handSettled) return;
      room.handNumber += 1;
      handNumber = room.handNumber;
      room.handSettled = false;
      for (const player of Object.values(room.players)) {
        player.handCommitted = 0;
        player.roundCommitted = 0;
        player.folded = false;
        player.allIn = false;
        player.inHand = player.balance > 0;
      }
      room.round = freshRound();
      return room;
    });
    if (!result.committed) return showToast("Settle the current pot before starting the next hand.");
    await logActivity(`Started hand ${handNumber}.`);
  } catch (error) {
    console.error(error);
    showToast("Could not start the next hand.");
  } finally {
    setBusy(button, false);
  }
}

function attachEvents() {
  els.createForm.addEventListener("submit", createRoom);
  els.joinForm.addEventListener("submit", joinRoom);
  els.joinCode.addEventListener("input", () => {
    els.joinCode.value = cleanCode(els.joinCode.value);
  });
  els.actionCheck.addEventListener("click", () => performPokerAction("check", null, els.actionCheck));
  els.actionCall.addEventListener("click", () => performPokerAction("call", null, els.actionCall));
  els.actionFold.addEventListener("click", () => performPokerAction("fold", null, els.actionFold));
  els.actionAllIn.addEventListener("click", () => performPokerAction("allin", null, els.actionAllIn));
  els.actionRaise.addEventListener("click", () => performPokerAction("raise", els.raiseTarget.value, els.actionRaise));
  els.raiseTarget.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      performPokerAction("raise", els.raiseTarget.value, els.actionRaise);
    }
  });
  els.donateButton.addEventListener("click", () => donateChips(els.donateButton));
  els.hostAdd.addEventListener("click", () => hostAdjust(1, els.hostAdd));
  els.hostRemove.addEventListener("click", () => hostAdjust(-1, els.hostRemove));
  els.hostNextRound.addEventListener("click", () => nextBettingRound(els.hostNextRound));
  els.hostSettle.addEventListener("click", () => settlePots(els.hostSettle));
  els.hostNextHand.addEventListener("click", () => nextHand(els.hostNextHand));
  els.leaveRoom.addEventListener("click", leaveRoom);
  els.copyRoom.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl());
      showToast("Invite link copied.");
    } catch {
      showToast(`Room code: ${currentRoomCode}`);
    }
  });
  window.addEventListener("popstate", () => window.location.reload());
}

async function bootstrap() {
  attachEvents();
  const rememberedName = localStorage.getItem("pocketChipsName") || "";
  els.createName.value = rememberedName;
  els.joinName.value = rememberedName;

  const requestedCode = cleanCode(new URLSearchParams(location.search).get("room") || "");
  if (requestedCode) els.joinCode.value = requestedCode;

  if (!isFirebaseConfigured()) {
    els.setupWarning.classList.remove("hidden");
    els.connectionPill.textContent = "Setup needed";
    document.querySelectorAll("button[type='submit']").forEach((button) => button.disabled = true);
    return;
  }

  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getDatabase(app);

    onValue(ref(db, ".info/connected"), (snapshot) => {
      const connected = snapshot.val() === true;
      els.connectionPill.textContent = connected ? "Live" : "Offline";
      els.connectionPill.classList.toggle("online", connected);
    });

    onAuthStateChanged(auth, async (user) => {
      currentUser = user;
      if (!user) {
        try {
          await ensureSignedIn();
        } catch (error) {
          console.error(error);
          showToast("Anonymous sign-in failed. Check Firebase Authentication setup.");
        }
        return;
      }

      if (requestedCode) {
        try {
          const snap = await get(ref(db, `rooms/${requestedCode}`));
          if (snap.exists() && snap.val().players?.[user.uid]) await enterRoom(requestedCode);
        } catch (error) {
          console.error(error);
        }
      }
    });

    await ensureSignedIn();
  } catch (error) {
    console.error(error);
    els.setupWarning.classList.remove("hidden");
    els.connectionPill.textContent = "Setup error";
    showToast("Firebase could not initialize. Check firebase-config.js.");
  }
}

bootstrap();
