import { world, system, DisplaySlotId, ItemStack } from "@minecraft/server";

// ===== 調整用の数値 =====
const SHOT_POWER = 1.2; // 普通に叩いたとき（シュート）の強さ
const SHOT_LIFT = 0.35; // シュートの浮き上がり（上を向くとさらに高く上がる）
const PASS_POWER = 0.6; // スニーク中に叩いたとき（パス）の強さ
const PASS_LIFT = 0.12;
const DRIBBLE_RANGE = 1.0; // ドリブルでボールが押される距離
const RESET_DELAY = 60; // ゴール後、ボールが戻るまでの時間（tick、20 = 1秒）

const BALL = "soccer:ball";
const RED_TEAM = "§c赤チーム";
const BLUE_TEAM = "§9青チーム";
// 赤ゴールは赤チームが守るゴール。赤ゴールに入ったら青チームの得点
const GOALS = {
  "soccer:goal_red": { frame: "minecraft:red_concrete", name: "§c赤ゴール", scorer: BLUE_TEAM },
  "soccer:goal_blue": { frame: "minecraft:blue_concrete", name: "§9青ゴール", scorer: RED_TEAM },
};
const NET = "minecraft:iron_bars";
const DIMENSIONS = ["overworld", "nether", "the_end"];

// 向き: 0=南(+z) 1=西(-x) 2=北(-z) 3=東(+x)
const DIRS = [
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 0, z: -1 },
  { x: 1, z: 0 },
];

function isValid(entity) {
  if (!entity) return false;
  return typeof entity.isValid === "function" ? entity.isValid() : entity.isValid;
}

function yawToDir(yaw) {
  return ((Math.round(yaw / 90) % 4) + 4) % 4;
}

function goalDir(goal) {
  for (let i = 0; i < 4; i++) {
    if (goal.hasTag(`soccer_dir${i}`)) return i;
  }
  return undefined;
}

// ゴールの基準点（ゴールラインの中央の足元ブロック）と、奥向き(f)・横向き(r)
function goalFrame(goal) {
  const dir = goalDir(goal);
  if (dir === undefined) return undefined;
  const f = DIRS[dir];
  const r = { x: -f.z, z: f.x };
  const loc = goal.location;
  const base = { x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) };
  return { base, f, r };
}

// ===== スコア =====
function getObjective() {
  let obj = world.scoreboard.getObjective("soccer_score");
  if (!obj) {
    obj = world.scoreboard.addObjective("soccer_score", "サッカー スコア");
    obj.setScore(RED_TEAM, 0);
    obj.setScore(BLUE_TEAM, 0);
  }
  world.scoreboard.setObjectiveAtDisplaySlot(DisplaySlotId.Sidebar, { objective: obj });
  return obj;
}

function getScore(obj, name) {
  try {
    return obj.getScore(name) ?? 0;
  } catch {
    return 0;
  }
}

function resetScores() {
  const obj = getObjective();
  obj.setScore(RED_TEAM, 0);
  obj.setScore(BLUE_TEAM, 0);
}

system.run(() => getObjective());

// ===== キック =====
world.afterEvents.entityHitEntity.subscribe((ev) => {
  const ball = ev.hitEntity;
  const player = ev.damagingEntity;
  if (!ball || ball.typeId !== BALL || ball.hasTag("soccer_scored")) return;
  if (player?.typeId === JP_PLAYER) {
    npcKick(ball, player);
    return;
  }
  if (!player || player.typeId !== "minecraft:player") return;

  const view = player.getViewDirection();
  const len = Math.hypot(view.x, view.z) || 1;
  const dx = view.x / len;
  const dz = view.z / len;

  let power, lift;
  if (player.isSneaking) {
    power = PASS_POWER;
    lift = PASS_LIFT;
  } else {
    power = SHOT_POWER;
    lift = Math.min(0.9, Math.max(0.15, SHOT_LIFT + view.y * 0.6));
  }

  ball.clearVelocity();
  ball.applyImpulse({ x: dx * power, y: lift, z: dz * power });
});

// ===== ゴールの設置 =====
function setBlock(dimension, pos, type) {
  try {
    dimension.getBlock(pos)?.setType(type);
  } catch {
    // 読み込まれていない場所などは無視
  }
}

function buildGoal(goal, frameBlock) {
  const { base, f, r } = goalFrame(goal);
  const dim = goal.dimension;
  const at = (i, j, y) => ({
    x: base.x + r.x * i + f.x * j,
    y: base.y + y,
    z: base.z + r.z * i + f.z * j,
  });

  // ゴールの中（幅5 × 高さ3 × 奥行き2）を空ける
  for (let i = -2; i <= 2; i++)
    for (let j = 0; j <= 1; j++) for (let y = 0; y <= 2; y++) setBlock(dim, at(i, j, y), "minecraft:air");

  // ゴールポストとクロスバー
  for (let y = 0; y <= 2; y++) {
    setBlock(dim, at(-3, 0, y), frameBlock);
    setBlock(dim, at(3, 0, y), frameBlock);
  }
  for (let i = -3; i <= 3; i++) setBlock(dim, at(i, 0, 3), frameBlock);

  // ネット（横・上・奥）
  for (let y = 0; y <= 2; y++) {
    setBlock(dim, at(-3, 1, y), NET);
    setBlock(dim, at(3, 1, y), NET);
  }
  for (let i = -3; i <= 3; i++) setBlock(dim, at(i, 1, 3), NET);
  for (let i = -3; i <= 3; i++) for (let y = 0; y <= 3; y++) setBlock(dim, at(i, 2, y), NET);
}

// ゴールの向きを決めて組み立てる（同じ色の古いゴールの目印は消す）
function placeGoal(goal, dir) {
  for (const old of goal.dimension.getEntities({ type: goal.typeId })) {
    if (old.id !== goal.id) old.remove();
  }
  for (let i = 0; i < 4; i++) goal.removeTag(`soccer_dir${i}`);
  goal.addTag(`soccer_dir${dir}`);
  buildGoal(goal, GOALS[goal.typeId].frame);
  goalCache.clear();
}

world.afterEvents.entitySpawn.subscribe((ev) => {
  const goal = ev.entity;
  if (!isValid(goal)) return;
  const info = GOALS[goal.typeId];
  if (!info) return;
  if (goalDir(goal) !== undefined) return; // ワールド読み込み時やスタジアムで置いたゴールは無視

  // 一番近いプレイヤーの向いている方向へゴールを作る（入口がプレイヤー側を向く）
  const [player] = goal.dimension.getPlayers({ location: goal.location, closest: 1 });
  placeGoal(goal, player ? yawToDir(player.getRotation().y) : 0);
  if (player) player.sendMessage(`${info.name}§rを設置しました！`);
});

// ===== ゴール判定 =====
function centerFor(dimension, scoredGoal) {
  const red = dimension.getEntities({ type: "soccer:goal_red" })[0];
  const blue = dimension.getEntities({ type: "soccer:goal_blue" })[0];
  if (red && blue) {
    return {
      x: (red.location.x + blue.location.x) / 2,
      y: Math.max(red.location.y, blue.location.y) + 0.5,
      z: (red.location.z + blue.location.z) / 2,
    };
  }
  // ゴールが1つしかないときは、そのゴールの前（5ブロック手前）に戻す
  const { base, f } = goalFrame(scoredGoal);
  return { x: base.x + 0.5 - f.x * 5, y: base.y + 0.5, z: base.z + 0.5 - f.z * 5 };
}

function placeBall(ball, pos) {
  if (!isValid(ball)) return;
  ball.teleport(pos);
  ball.clearVelocity();
  ball.removeTag("soccer_scored");
}

function onGoal(ball, goal) {
  const info = GOALS[goal.typeId];
  ball.addTag("soccer_scored");

  const obj = getObjective();
  obj.addScore(info.scorer, 1);
  const red = getScore(obj, RED_TEAM);
  const blue = getScore(obj, BLUE_TEAM);

  for (const p of world.getAllPlayers()) {
    p.onScreenDisplay.setTitle("§eゴール！", {
      subtitle: `${info.scorer}§rの得点！  §c赤 ${red}§r - §9${blue} 青`,
      fadeInDuration: 5,
      stayDuration: 50,
      fadeOutDuration: 10,
    });
    try {
      p.playSound("random.levelup");
    } catch {}
  }

  const center = centerFor(goal.dimension, goal);
  startRetreat(goal.dimension, RESET_DELAY + 20); // キックオフまで日本代表は青コート（自陣）へ戻る
  system.runTimeout(() => {
    placeBall(ball, center);
    kickoffPositions(goal.dimension, center);
  }, RESET_DELAY);
}

function checkGoal(ball, goals) {
  const p = ball.location;
  for (const goal of goals) {
    const frame = goalFrame(goal);
    if (!frame) continue;
    const { base, f, r } = frame;
    const rx = p.x - (base.x + 0.5);
    const rz = p.z - (base.z + 0.5);
    const depth = rx * f.x + rz * f.z; // ゴールラインより奥へ何ブロックか
    const side = rx * r.x + rz * r.z; // ゴール中央から横へ何ブロックか
    const height = p.y - base.y;
    if (depth > 0 && depth < 1.6 && Math.abs(side) < 2.5 && height > -0.5 && height < 3) {
      onGoal(ball, goal);
      return;
    }
  }
}

// ===== ドリブル =====
function dribble(ball, players) {
  const bp = ball.location;
  for (const player of players) {
    const pp = player.location;
    const dx = bp.x - pp.x;
    const dz = bp.z - pp.z;
    if (Math.hypot(dx, dz) > DRIBBLE_RANGE || Math.abs(bp.y - pp.y) > 1.5) continue;

    const pv = player.getVelocity();
    const speed = Math.hypot(pv.x, pv.z);
    if (speed < 0.05) continue;
    // プレイヤーが進む方向の前にボールがあるときだけ押す
    if (dx * pv.x + dz * pv.z <= 0) continue;

    const bv = ball.getVelocity();
    const want = { x: pv.x * 1.4, z: pv.z * 1.4 };
    if (Math.hypot(bv.x, bv.z) >= Math.hypot(want.x, want.z)) continue;
    ball.applyImpulse({ x: want.x - bv.x, y: 0, z: want.z - bv.z });
    return;
  }
}

// ゴールの目印は動かないので、1秒ごとにだけ探し直す（軽量化）
const goalCache = new Map();

function getGoals(dim) {
  const cached = goalCache.get(dim.id);
  if (cached && cached.until > system.currentTick && cached.list.every(isValid)) return cached.list;
  const list = [...dim.getEntities({ type: "soccer:goal_red" }), ...dim.getEntities({ type: "soccer:goal_blue" })];
  goalCache.set(dim.id, { list, until: system.currentTick + 20 });
  return list;
}

function findGoal(dim, type) {
  return getGoals(dim).find((g) => g.typeId === type);
}

// プレイヤーがいるディメンションだけを調べる（軽量化）
function activeDimensions() {
  const dims = new Map();
  for (const p of world.getAllPlayers()) dims.set(p.dimension.id, p.dimension);
  return [...dims.values()];
}

system.runInterval(() => {
  for (const dim of activeDimensions()) {
    const balls = dim.getEntities({ type: BALL });
    if (balls.length === 0) continue;
    const goals = getGoals(dim);
    const players = dim.getPlayers();
    for (const keeper of dim.getEntities({ type: JP_KEEPER })) keeperTick(keeper, balls);
    retreatTick(dim, balls);
    for (const ball of balls) {
      if (ball.hasTag("soccer_scored")) continue;
      dribble(ball, players);
      checkGoal(ball, goals);
    }
  }
}, 2);

// ===== コマンド =====
// /scriptevent soccer:reset  … スコアを0に戻してボールをセンターへ
// /scriptevent soccer:clear  … ボール・選手・ゴールの目印を消す（ブロックは残る）
// /scriptevent soccer:japan  … 日本代表（GK＋10人）をまとめて呼ぶ
// /scriptevent soccer:boots  … サッカーシューズ（シュート用）をもらう
// /scriptevent soccer:stadium … 目の前にスタジアムを建てる
system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id === "soccer:reset") {
    resetScores();
    for (const id of DIMENSIONS) {
      const dim = world.getDimension(id);
      const goal = dim.getEntities({ type: "soccer:goal_red" })[0] ?? dim.getEntities({ type: "soccer:goal_blue" })[0];
      if (!goal || !goalFrame(goal)) continue;
      const center = centerFor(dim, goal);
      for (const ball of dim.getEntities({ type: BALL })) placeBall(ball, center);
      kickoffPositions(dim, center);
    }
    world.sendMessage("§eスコアをリセットしました。キックオフ！");
  } else if (ev.id === "soccer:clear") {
    for (const id of DIMENSIONS) {
      const dim = world.getDimension(id);
      for (const type of [BALL, JP_PLAYER, JP_KEEPER, ...Object.keys(GOALS)]) {
        for (const e of dim.getEntities({ type })) e.remove();
      }
    }
    world.sendMessage("§eボール・選手・ゴールの目印を消しました。");
  } else if (ev.id === "soccer:japan") {
    callJapan(ev.sourceEntity);
  } else if (ev.id === "soccer:stadium") {
    const p = ev.sourceEntity?.typeId === "minecraft:player" ? ev.sourceEntity : world.getAllPlayers()[0];
    if (p) buildStadium(p.dimension, p.location, yawToDir(p.getRotation().y));
  } else if (ev.id === "soccer:boots") {
    if (ev.sourceEntity?.typeId === "minecraft:player") giveBoots(ev.sourceEntity);
  }
});

// ===== 第2段階: 日本代表の選手 =====
const JP_PLAYER = "soccer:jp_player";
const JP_KEEPER = "soccer:jp_keeper";
// 背番号はW杯2026（北中米大会）の日本代表メンバーのもの
// 並び順はテクスチャ jp_player_0〜9 と対応
const JAPAN = [
  { num: 4, name: "板倉滉" },
  { num: 22, name: "冨安健洋" },
  { num: 21, name: "伊藤洋輝" },
  { num: 2, name: "菅原由勢" },
  { num: 7, name: "田中碧" },
  { num: 15, name: "鎌田大地" },
  { num: 8, name: "久保建英" },
  { num: 10, name: "堂安律" },
  { num: 14, name: "伊東純也" },
  { num: 18, name: "上田綺世" },
];
const JAPAN_KEEPER = { num: 1, name: "鈴木彩艶" };
// 日本代表は青チーム: 青ゴールを守り、赤ゴールを狙う
const JP_ATTACK_GOAL = "soccer:goal_red";
const JP_DEFEND_GOAL = "soccer:goal_blue";

const NPC_SHOOT_RANGE = 14; // 相手ゴールまでこの距離以内ならシュート
const NPC_SHOT_POWER = 1.1;
const NPC_DRIBBLE_POWER = 0.45;
const NPC_PASS_CHANCE = 0.25;
const KEEPER_REACH = 1.6; // キーパーがボールに触れる距離
const KEEPER_RUSH_RANGE = 7; // ゴールからこの距離にボールが来たら飛び出す

function playerIndex(entity) {
  for (const tag of entity.getTags()) {
    if (tag.startsWith("soccer_pid")) return Number(tag.slice(10));
  }
  return undefined;
}

function horizontalDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// ゴールの入口の中央（地面の高さ）
function goalMouth(goal) {
  const { base } = goalFrame(goal);
  return { x: base.x + 0.5, y: base.y, z: base.z + 0.5 };
}

function kickToward(ball, from, to, power, lift) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  ball.clearVelocity();
  ball.applyImpulse({ x: (dx / len) * power, y: lift, z: (dz / len) * power });
}

world.afterEvents.entitySpawn.subscribe((ev) => {
  const npc = ev.entity;
  if (!isValid(npc)) return;

  if (npc.typeId === JP_KEEPER) {
    if (npc.hasTag("soccer_keeper")) return;
    for (const old of npc.dimension.getEntities({ type: JP_KEEPER })) {
      if (old.id !== npc.id) old.remove();
    }
    npc.addTag("soccer_keeper");
    npc.nameTag = `§e${JAPAN_KEEPER.num} ${JAPAN_KEEPER.name}`;
    return;
  }

  if (npc.typeId !== JP_PLAYER || playerIndex(npc) !== undefined) return;
  const used = new Set(npc.dimension.getEntities({ type: JP_PLAYER }).map(playerIndex));
  const index = JAPAN.findIndex((_, i) => !used.has(i));
  if (index < 0) {
    npc.remove();
    const [p] = npc.dimension.getPlayers({ location: npc.location, closest: 1 });
    p?.sendMessage("§e日本代表のフィールドプレイヤーは全員出場しています！");
    return;
  }
  const info = JAPAN[index];
  npc.addTag(`soccer_pid${index}`);
  npc.triggerEvent(`soccer:v${index}`);
  npc.nameTag = `§b${info.num} ${info.name}`;
});

// フィールドプレイヤーがボールに追いついたとき
function npcKick(ball, npc) {
  const target = findGoal(npc.dimension, JP_ATTACK_GOAL);
  if (!target || !goalFrame(target)) {
    // 相手ゴールがないときは向いている方向へ蹴る
    const view = npc.getViewDirection();
    const to = { x: ball.location.x + view.x, z: ball.location.z + view.z };
    kickToward(ball, npc.location, to, NPC_DRIBBLE_POWER, 0.1);
    return;
  }

  const { base, f, r } = goalFrame(target);
  const mouth = goalMouth(target);
  const distance = horizontalDistance(ball.location, mouth);

  if (distance <= NPC_SHOOT_RANGE) {
    // シュート: ゴールの中のどこかを狙う
    const aim = (Math.random() * 2 - 1) * 1.8;
    const to = { x: base.x + 0.5 + f.x + r.x * aim, z: base.z + 0.5 + f.z + r.z * aim };
    kickToward(ball, ball.location, to, NPC_SHOT_POWER, 0.2 + Math.random() * 0.2);
    return;
  }

  // パス: 自分よりゴールに近い味方がいたら、ときどきパスを出す
  if (Math.random() < NPC_PASS_CHANCE) {
    const mates = [
      ...npc.dimension.getEntities({ type: JP_PLAYER, location: npc.location, maxDistance: 16 }),
      ...npc.dimension.getPlayers({ location: npc.location, maxDistance: 16 }), // 操作しているプレイヤーにもパスを出す
    ].filter((m) => m.id !== npc.id && horizontalDistance(m.location, mouth) < distance - 4);
    if (mates.length > 0) {
      const mate = mates[Math.floor(Math.random() * mates.length)];
      const d = horizontalDistance(ball.location, mate.location);
      kickToward(ball, ball.location, mate.location, Math.min(0.9, 0.25 + d * 0.05), 0.15);
      return;
    }
  }

  // ドリブル: ゴールの方向へ軽く蹴り出す
  kickToward(ball, ball.location, mouth, NPC_DRIBBLE_POWER, 0.08);
}

// キーパー: ゴール前でボールとゴールの間に立ち、近づいたら飛び出してクリア
const keeperCooldown = new Map();

function keeperTick(keeper, balls) {
  const goal = findGoal(keeper.dimension, JP_DEFEND_GOAL);
  if (!goal || !goalFrame(goal) || balls.length === 0) return;
  const { base, f, r } = goalFrame(goal);
  const mouth = goalMouth(goal);

  let ball = balls[0];
  for (const b of balls) {
    if (horizontalDistance(b.location, mouth) < horizontalDistance(ball.location, mouth)) ball = b;
  }
  const kp = keeper.location;
  const bp = ball.location;

  // ボールに届いたらクリア（相手ゴール方向＝自分のゴールから離れる方向へ大きく蹴る）
  const now = system.currentTick;
  if (
    !ball.hasTag("soccer_scored") &&
    horizontalDistance(kp, bp) < KEEPER_REACH &&
    Math.abs(kp.y - bp.y) < 2 &&
    (keeperCooldown.get(keeper.id) ?? 0) <= now
  ) {
    keeperCooldown.set(keeper.id, now + 20);
    const enemy = findGoal(keeper.dimension, JP_ATTACK_GOAL);
    const to = enemy ? enemy.location : { x: mouth.x - f.x * 20, z: mouth.z - f.z * 20 };
    kickToward(ball, bp, to, 1.3, 0.6);
    return;
  }

  // 立つ位置を決める
  let spot;
  if (horizontalDistance(bp, mouth) < KEEPER_RUSH_RANGE) {
    spot = { x: bp.x, z: bp.z }; // 飛び出す
  } else {
    const side = (bp.x - mouth.x) * r.x + (bp.z - mouth.z) * r.z;
    const s = Math.max(-2, Math.min(2, side * 0.3));
    spot = { x: mouth.x - f.x * 1.5 + r.x * s, z: mouth.z - f.z * 1.5 + r.z * s };
  }

  const dx = spot.x - kp.x;
  const dz = spot.z - kp.z;
  const dist = Math.hypot(dx, dz);
  const step = Math.min(dist, horizontalDistance(bp, mouth) < KEEPER_RUSH_RANGE ? 0.4 : 0.25);
  const next =
    dist > 0.05 ? { x: kp.x + (dx / dist) * step, y: kp.y, z: kp.z + (dz / dist) * step } : kp;
  keeper.teleport(next, { facingLocation: { x: bp.x, y: bp.y + 0.5, z: bp.z } });
}

// /scriptevent soccer:japan で全員を呼ぶ
function callJapan(source) {
  const player = source?.typeId === "minecraft:player" ? source : world.getAllPlayers()[0];
  if (!player) return;
  const dim = player.dimension;
  const loc = player.location;
  const used = new Set(dim.getEntities({ type: JP_PLAYER }).map(playerIndex));
  let n = 0;
  JAPAN.forEach((_, i) => {
    if (used.has(i)) return;
    const angle = (n++ / JAPAN.length) * Math.PI * 2;
    dim.spawnEntity(JP_PLAYER, { x: loc.x + Math.cos(angle) * 4, y: loc.y, z: loc.z + Math.sin(angle) * 4 });
  });

  const goal = dim.getEntities({ type: JP_DEFEND_GOAL })[0];
  if (dim.getEntities({ type: JP_KEEPER }).length === 0) {
    const at = goal && goalFrame(goal) ? goalMouth(goal) : { x: loc.x + 2, y: loc.y, z: loc.z };
    dim.spawnEntity(JP_KEEPER, { x: at.x, y: at.y + 0.1, z: at.z });
  }
  world.sendMessage("§b日本代表が集合しました！");
}

// ===== 第2.5段階: コントローラー操作（FC風） =====
// マイクラの操作を次のサッカーの動きに割り当てる（ボタンの割り当てはマイクラの設定で変える）
//   ジャンプ         → パス（近くの味方へ自動で狙う）
//   使う（シューズ） → シュート（相手ゴールの方を向いていれば自動で狙う）
//   スニーク         → ロブパス／クロス（浮き球）
//   アイテムを捨てる → スルーパス（味方の前のスペースへ）
//   スプリント       → ダッシュ（マイクラの通常のダッシュ）
const BOOTS = "soccer:boots";
const KICK_RANGE = 2.2; // この距離以内にボールがあるとボタンで蹴れる
const PASS_CONE = 0.7; // パス相手を探す向きの幅（cos、0.7 ≒ 左右45度）
const SHOT_CONE = 0.5; // ゴールを自動で狙う向きの幅（cos、0.5 ≒ 左右60度）
const BUTTON_COOLDOWN = 6; // tick

const lastJump = new Map();
const lastSneak = new Map();
const lastOnGround = new Map();
const nextKickTick = new Map();

// 左スティックで動いている方向（止まっているときは向いている方向）
function stickDirection(player) {
  const v = player.getVelocity();
  const speed = Math.hypot(v.x, v.z);
  if (speed > 0.04) return { x: v.x / speed, z: v.z / speed };
  const view = player.getViewDirection();
  const len = Math.hypot(view.x, view.z) || 1;
  return { x: view.x / len, z: view.z / len };
}

function nearestBall(player) {
  let best;
  let bestDist = KICK_RANGE;
  for (const ball of player.dimension.getEntities({ type: BALL, location: player.location, maxDistance: KICK_RANGE + 1 })) {
    if (ball.hasTag("soccer_scored")) continue;
    const d = horizontalDistance(ball.location, player.location);
    if (d <= bestDist && Math.abs(ball.location.y - player.location.y) < 1.5) {
      best = ball;
      bestDist = d;
    }
  }
  return best;
}

// 向いている方向にいる味方を探す（角度が近いほど、近いほど優先）
function findMate(player, ball, dir) {
  let best;
  let bestScore = -Infinity;
  const mates = [
    ...player.dimension.getEntities({ type: JP_PLAYER, location: ball.location, maxDistance: 32 }),
    ...player.dimension.getPlayers({ location: ball.location, maxDistance: 32 }).filter((p) => p.id !== player.id),
  ];
  for (const mate of mates) {
    const dx = mate.location.x - ball.location.x;
    const dz = mate.location.z - ball.location.z;
    const d = Math.hypot(dx, dz);
    if (d < 2) continue;
    const cos = (dx * dir.x + dz * dir.z) / d;
    if (cos < PASS_CONE) continue;
    const score = cos * 2 - d / 32;
    if (score > bestScore) {
      best = mate;
      bestScore = score;
    }
  }
  return best;
}

function canKick(player) {
  const now = system.currentTick;
  if ((nextKickTick.get(player.id) ?? 0) > now) return false;
  nextKickTick.set(player.id, now + BUTTON_COOLDOWN);
  return true;
}

function kickInDirection(ball, dir, power, lift) {
  ball.clearVelocity();
  ball.applyImpulse({ x: dir.x * power, y: lift, z: dir.z * power });
}

function doPass(player) {
  const ball = nearestBall(player);
  if (!ball || !canKick(player)) return;
  const dir = stickDirection(player);
  const mate = findMate(player, ball, dir);
  if (mate) {
    const d = horizontalDistance(ball.location, mate.location);
    kickToward(ball, ball.location, mate.location, Math.min(1.0, 0.25 + d * 0.045), 0.1);
  } else {
    kickInDirection(ball, dir, 0.6, 0.1);
  }
}

function doLob(player) {
  const ball = nearestBall(player);
  if (!ball || !canKick(player)) return;
  const dir = stickDirection(player);
  const mate = findMate(player, ball, dir);
  if (mate) {
    const d = horizontalDistance(ball.location, mate.location);
    kickToward(ball, ball.location, mate.location, Math.min(1.0, 0.2 + d * 0.03), 0.55);
  } else {
    kickInDirection(ball, dir, 0.6, 0.55);
  }
}

function doThroughPass(player) {
  const ball = nearestBall(player);
  if (!ball || !canKick(player)) return;
  const dir = stickDirection(player);
  const mate = findMate(player, ball, dir);
  if (!mate) {
    kickInDirection(ball, dir, 0.8, 0.08);
    return;
  }
  // 味方の少し前（相手ゴール側、なければパスの方向）へ出す
  const goal = findGoal(player.dimension, JP_ATTACK_GOAL);
  let ahead = dir;
  if (goal && goalFrame(goal)) {
    const mouth = goalMouth(goal);
    const gx = mouth.x - mate.location.x;
    const gz = mouth.z - mate.location.z;
    const len = Math.hypot(gx, gz) || 1;
    ahead = { x: gx / len, z: gz / len };
  }
  const spot = { x: mate.location.x + ahead.x * 4, z: mate.location.z + ahead.z * 4 };
  const d = horizontalDistance(ball.location, spot);
  kickToward(ball, ball.location, spot, Math.min(1.1, 0.3 + d * 0.045), 0.08);
}

function doShot(player) {
  const ball = nearestBall(player);
  if (!ball || !canKick(player)) return;
  const dir = stickDirection(player);
  const goal = findGoal(player.dimension, JP_ATTACK_GOAL);
  if (goal && goalFrame(goal)) {
    const { base, f, r } = goalFrame(goal);
    const mouth = goalMouth(goal);
    const gx = mouth.x - ball.location.x;
    const gz = mouth.z - ball.location.z;
    const gd = Math.hypot(gx, gz) || 1;
    if ((gx * dir.x + gz * dir.z) / gd > SHOT_CONE) {
      // ゴールの方を向いていたら、スティックの向きに近いほうのサイドを狙う
      const side = Math.max(-1.8, Math.min(1.8, (dir.x * r.x + dir.z * r.z) * 6));
      const to = { x: base.x + 0.5 + f.x + r.x * side, z: base.z + 0.5 + f.z + r.z * side };
      kickToward(ball, ball.location, to, 1.25, Math.min(0.45, 0.2 + gd * 0.01));
      return;
    }
  }
  kickInDirection(ball, dir, 1.2, 0.3);
}

// シュート: シューズを持って「使う」
world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack?.typeId !== BOOTS) return;
  doShot(ev.source);
});

// スルーパス: シューズを「捨てる」→ すぐ手元に戻す
world.afterEvents.entitySpawn.subscribe((ev) => {
  const item = ev.entity;
  if (!isValid(item) || item.typeId !== "minecraft:item") return;
  const stack = item.getComponent("minecraft:item")?.itemStack;
  if (stack?.typeId !== BOOTS) return;
  const [player] = item.dimension.getPlayers({ location: item.location, closest: 1, maxDistance: 4 });
  item.remove();
  if (!player) return;
  giveBoots(player, true);
  doThroughPass(player);
});

function hasBoots(player) {
  const inv = player.getComponent("minecraft:inventory")?.container;
  if (!inv) return true;
  for (let i = 0; i < inv.size; i++) {
    if (inv.getItem(i)?.typeId === BOOTS) return true;
  }
  return false;
}

function giveBoots(player, toSelectedSlot = false) {
  const inv = player.getComponent("minecraft:inventory")?.container;
  if (!inv) return;
  const slot = player.selectedSlotIndex ?? player.selectedSlot;
  if (toSelectedSlot && slot !== undefined && !inv.getItem(slot)) {
    inv.setItem(slot, new ItemStack(BOOTS, 1));
  } else if (!hasBoots(player)) {
    inv.addItem(new ItemStack(BOOTS, 1));
  }
}

world.afterEvents.playerSpawn.subscribe((ev) => {
  if (ev.initialSpawn) system.runTimeout(() => giveBoots(ev.player), 20);
});

// パス（ジャンプ）とロブ（スニーク）は、ボタンを押した瞬間を見つける
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    // isJumping が使えない版では「地面から上向きに飛び出した瞬間」で判定する
    const jumping =
      player.isJumping ?? (lastOnGround.get(player.id) && !player.isOnGround && player.getVelocity().y > 0.2);
    lastOnGround.set(player.id, player.isOnGround);
    const sneaking = player.isSneaking;
    if (jumping && !lastJump.get(player.id)) doPass(player);
    if (sneaking && !lastSneak.get(player.id)) doLob(player);
    lastJump.set(player.id, jumping);
    lastSneak.set(player.id, sneaking);
  }
}, 1);

// ===== 戻り（リトリート）: ゴールが決まったら、キックオフまでそれぞれ自陣へ戻る =====
const RETREAT_STEP = 0.35; // 2tickごとに進む距離
// 戻る位置（4-4-2）: [青ゴールからの距離の割合, 横の位置] 並びは JAPAN と同じ
const FORMATION = [
  [0.15, -4], [0.15, 4], [0.2, -11], [0.2, 11],
  [0.3, -5], [0.3, 5], [0.38, -11], [0.38, 11],
  [0.45, -4], [0.45, 4],
];
const retreatUntil = new Map();

function setChasing(npc, on) {
  const tag = on ? "soccer_chase_on" : "soccer_chase_off";
  if (npc.hasTag(tag)) return;
  npc.removeTag(on ? "soccer_chase_off" : "soccer_chase_on");
  npc.addTag(tag);
  npc.triggerEvent(on ? "soccer:chase_on" : "soccer:chase_off");
}

function startRetreat(dim, ticks) {
  const until = Math.max(retreatUntil.get(dim.id) ?? 0, system.currentTick + ticks);
  retreatUntil.set(dim.id, until);
  for (const npc of dim.getEntities({ type: JP_PLAYER })) setChasing(npc, false);
}

function isPassable(dim, pos) {
  try {
    const block = dim.getBlock(pos);
    if (!block) return false;
    return block.isAir ?? block.typeId === "minecraft:air";
  } catch {
    return false;
  }
}

function retreatTick(dim, balls) {
  const until = retreatUntil.get(dim.id);
  if (until === undefined) return;
  const npcs = dim.getEntities({ type: JP_PLAYER });
  if (system.currentTick >= until) {
    retreatUntil.delete(dim.id);
    for (const npc of npcs) setChasing(npc, true);
    return;
  }

  const blue = findGoal(dim, JP_DEFEND_GOAL);
  const red = findGoal(dim, JP_ATTACK_GOAL);
  if (!blue || !red || !goalFrame(blue) || !goalFrame(red)) return;
  const B = goalMouth(blue);
  const R = goalMouth(red);
  const length = horizontalDistance(B, R) || 1;
  const u = { x: (R.x - B.x) / length, z: (R.z - B.z) / length };
  const v = { x: -u.z, z: u.x };
  const ball = balls[0];

  for (const npc of npcs) {
    const slot = FORMATION[playerIndex(npc) ?? 0];
    const spot = {
      x: B.x + u.x * length * slot[0] + v.x * slot[1],
      z: B.z + u.z * length * slot[0] + v.z * slot[1],
    };
    const p = npc.location;
    const dx = spot.x - p.x;
    const dz = spot.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.3) continue;
    const step = Math.min(dist, RETREAT_STEP);
    const next = { x: p.x + (dx / dist) * step, y: p.y, z: p.z + (dz / dist) * step };
    // 壁や段差に埋まらないように、足元と頭の位置が空いているときだけ進む
    if (!isPassable(dim, next) || !isPassable(dim, { x: next.x, y: next.y + 1, z: next.z })) continue;
    const look = ball ? ball.location : { x: R.x, y: p.y, z: R.z };
    npc.teleport(next, { facingLocation: { x: look.x, y: p.y + 1.5, z: look.z } });
  }
}

// ===== スタジアム =====
const HALF_LENGTH = 25; // センターからゴールラインまで
const HALF_WIDTH = 16; // センターからタッチラインまで
const FILL_LIMIT = 32768; // fill コマンド1回で置けるブロック数の上限
const COMMANDS_PER_TICK = 4; // 1tickに実行するコマンド数（一度に置きすぎて固まらないように）

function runCommand(dim, cmd) {
  try {
    if (typeof dim.runCommand === "function") dim.runCommand(cmd);
    else dim.runCommandAsync(cmd);
  } catch {
    // 読み込まれていない場所などは無視
  }
}

function buildStadium(dim, loc, dir) {
  const f = DIRS[dir];
  const r = { x: -f.z, z: f.x };
  const cx = Math.floor(loc.x);
  const cz = Math.floor(loc.z);
  const y0 = Math.floor(loc.y) - 1; // 芝生の高さ（足元のブロック）
  const at = (u, v, h) => ({ x: cx + f.x * u + r.x * v, y: y0 + h, z: cz + f.z * u + r.z * v });
  const cmds = [];

  // 範囲を (u, v, h) で指定して fill。大きすぎるときは u 方向に分割する
  const fill = (u1, v1, h1, u2, v2, h2, block) => {
    const [ua, ub] = [Math.min(u1, u2), Math.max(u1, u2)];
    const perU = (Math.abs(v2 - v1) + 1) * (Math.abs(h2 - h1) + 1);
    const slice = Math.max(1, Math.floor(FILL_LIMIT / perU));
    for (let s = ua; s <= ub; s += slice) {
      const e = Math.min(ub, s + slice - 1);
      const a = at(s, v1, h1);
      const b = at(e, v2, h2);
      cmds.push(`fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${block}`);
    }
  };
  const set = (u, v, h, block) => {
    const a = at(u, v, h);
    cmds.push(`setblock ${a.x} ${a.y} ${a.z} ${block}`);
  };

  const HL = HALF_LENGTH;
  const HW = HALF_WIDTH;
  const LU = HL + 10;
  const LV = HW + 12;

  // 土台: 上を空けて、土と芝生を敷く
  fill(-LU, -LV, 1, LU, LV, 16, "air");
  fill(-LU, -LV, -2, LU, LV, -1, "dirt");
  fill(-LU, -LV, 0, LU, LV, 0, "grass_block");

  // ライン（白）
  const line = "white_concrete";
  fill(-HL, -HW, 0, HL, -HW, 0, line); // タッチライン
  fill(-HL, HW, 0, HL, HW, 0, line);
  fill(-HL, -HW, 0, -HL, HW, 0, line); // ゴールライン
  fill(HL, -HW, 0, HL, HW, 0, line);
  fill(0, -HW, 0, 0, HW, 0, line); // ハーフウェーライン
  for (const s of [1, -1]) {
    // ペナルティエリア
    fill(s * (HL - 8), -10, 0, s * (HL - 8), 10, 0, line);
    fill(s * (HL - 8), -10, 0, s * HL, -10, 0, line);
    fill(s * (HL - 8), 10, 0, s * HL, 10, 0, line);
    // ゴールエリア
    fill(s * (HL - 3), -5, 0, s * (HL - 3), 5, 0, line);
    fill(s * (HL - 3), -5, 0, s * HL, -5, 0, line);
    fill(s * (HL - 3), 5, 0, s * HL, 5, 0, line);
    set(s * (HL - 6), 0, 0, line); // ペナルティマーク
  }
  // センターサークル
  for (let u = -6; u <= 6; u++) {
    for (let v = -6; v <= 6; v++) {
      if (Math.abs(Math.hypot(u, v) - 5) < 0.5) set(u, v, 0, line);
    }
  }

  // 観客席（タッチラインの外、青と白のしま模様の階段）
  for (let k = 0; k < 6; k++) {
    const color = k % 2 === 0 ? "blue_concrete" : "white_concrete";
    fill(-HL, HW + 6 + k, 1, HL, HW + 6 + k, k + 1, color);
    fill(-HL, -(HW + 6 + k), 1, HL, -(HW + 6 + k), k + 1, color);
  }

  // 照明塔（四隅）
  for (const su of [1, -1]) {
    for (const sv of [1, -1]) {
      const u = su * (HL + 7);
      const v = sv * (HW + 8);
      fill(u, v, 1, u, v, 12, "white_concrete");
      fill(u - 1, v - 1, 13, u + 1, v + 1, 13, "sea_lantern");
    }
  }

  // ボールが外へ出ていかないように、見えない壁（バリア）で囲む
  const BU = HL + 5;
  const BV = HW + 5;
  fill(-BU, -BV, 1, BU, -BV, 4, "barrier");
  fill(-BU, BV, 1, BU, BV, 4, "barrier");
  fill(-BU, -BV, 1, -BU, BV, 4, "barrier");
  fill(BU, -BV, 1, BU, BV, 4, "barrier");

  const players = dim.getPlayers({ location: loc, maxDistance: 64 });
  for (const p of players) p.sendMessage("§eスタジアムを建設中…");

  let i = 0;
  const job = system.runInterval(() => {
    for (let n = 0; n < COMMANDS_PER_TICK && i < cmds.length; n++) runCommand(dim, cmds[i++]);
    if (i < cmds.length) return;
    system.clearRun(job);
    finishStadium(dim, at, dir, players);
  }, 1);
}

function finishStadium(dim, at, dir, players) {
  const center = (u, v) => {
    const p = at(u, v, 1);
    return { x: p.x + 0.5, y: p.y, z: p.z + 0.5 };
  };
  // 奥（向いている方向）が赤ゴール＝日本代表が攻めるゴール、手前が青ゴール
  const red = dim.spawnEntity("soccer:goal_red", center(HALF_LENGTH, 0));
  placeGoal(red, dir);
  const blue = dim.spawnEntity("soccer:goal_blue", center(-HALF_LENGTH, 0));
  placeGoal(blue, (dir + 2) % 4);

  const kickoff = center(0, 0);
  const balls = dim.getEntities({ type: BALL });
  if (balls.length === 0) dim.spawnEntity(BALL, kickoff);
  for (const ball of balls) placeBall(ball, kickoff);

  // GK が出ていれば青ゴールの前へ
  for (const keeper of dim.getEntities({ type: JP_KEEPER })) keeper.teleport(center(-HALF_LENGTH + 2, 0));

  const start = center(-6, 0);
  // ワールドの出現地点（リスポーン地点）をピッチの上にする
  try {
    world.setDefaultSpawnLocation({ x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) });
  } catch {}
  for (const p of players) {
    if (!isValid(p)) continue;
    p.teleport(start, { facingLocation: { x: kickoff.x, y: kickoff.y + 1, z: kickoff.z } });
    p.sendMessage("§aスタジアムが完成しました！ 奥の§c赤ゴール§aを狙おう");
  }
}

// キックオフ: プレイヤーは青コート（自陣）側のセンターサークルの外へ
function kickoffPositions(dim, center) {
  const blue = findGoal(dim, JP_DEFEND_GOAL);
  if (!blue || !goalFrame(blue)) return;
  const B = goalMouth(blue);
  const len = horizontalDistance(B, center) || 1;
  const u = { x: (center.x - B.x) / len, z: (center.z - B.z) / len }; // 青ゴール → センター
  const v = { x: -u.z, z: u.x };
  dim.getPlayers({ location: center, maxDistance: 80 }).forEach((p, i) => {
    const side = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * 3;
    const spot = { x: center.x - u.x * 6 + v.x * side, y: center.y, z: center.z - u.z * 6 + v.z * side };
    p.teleport(spot, { facingLocation: { x: center.x, y: center.y + 1, z: center.z } });
  });
}

// ===== 新しいワールドでは、最初からサッカースタジアムに出現する =====
const STADIUM_BUILT = "soccer:stadium_built";
const NEW_WORLD_TICKS = 20 * 60 * 5; // 5分以内に入ったワールドを「新しいワールド」とみなす

function worldAge() {
  try {
    return world.getAbsoluteTime();
  } catch {
    return 0;
  }
}

world.afterEvents.playerSpawn.subscribe((ev) => {
  if (!ev.initialSpawn || world.getDynamicProperty(STADIUM_BUILT)) return;
  world.setDynamicProperty(STADIUM_BUILT, true);
  // 遊んでいる途中のワールドに後からアドオンを入れたときは、建物を壊さないように自動では建てない
  if (worldAge() > NEW_WORLD_TICKS) {
    ev.player.sendMessage("§eスタジアムを建てるときは §f/scriptevent soccer:stadium §eと入力してください");
    return;
  }
  // まわりの地形が読み込まれるのを少し待ってから建てる
  system.runTimeout(() => {
    const p = ev.player;
    if (!isValid(p)) return;
    buildStadium(p.dimension, p.location, yawToDir(p.getRotation().y));
  }, 60);
});
