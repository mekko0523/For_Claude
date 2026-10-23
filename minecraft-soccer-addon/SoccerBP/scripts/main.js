import { world, system, DisplaySlotId } from "@minecraft/server";

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

world.afterEvents.entitySpawn.subscribe((ev) => {
  const goal = ev.entity;
  if (!isValid(goal)) return;
  const info = GOALS[goal.typeId];
  if (!info) return;
  if (goalDir(goal) !== undefined) return; // ワールド読み込み時の再出現は無視

  // 同じ色の古いゴール（目印）は1つだけにする
  for (const old of goal.dimension.getEntities({ type: goal.typeId })) {
    if (old.id !== goal.id) old.remove();
  }

  // 一番近いプレイヤーの向いている方向へゴールを作る（入口がプレイヤー側を向く）
  const [player] = goal.dimension.getPlayers({ location: goal.location, closest: 1 });
  const dir = player ? yawToDir(player.getRotation().y) : 0;
  goal.addTag(`soccer_dir${dir}`);
  buildGoal(goal, info.frame);
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
  system.runTimeout(() => placeBall(ball, center), RESET_DELAY);
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

system.runInterval(() => {
  for (const id of DIMENSIONS) {
    let dim;
    try {
      dim = world.getDimension(id);
    } catch {
      continue;
    }
    const balls = dim.getEntities({ type: BALL });
    if (balls.length === 0) continue;
    const goals = [
      ...dim.getEntities({ type: "soccer:goal_red" }),
      ...dim.getEntities({ type: "soccer:goal_blue" }),
    ];
    const players = dim.getPlayers();
    for (const keeper of dim.getEntities({ type: JP_KEEPER })) keeperTick(keeper, balls);
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
system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id === "soccer:reset") {
    resetScores();
    for (const id of DIMENSIONS) {
      const dim = world.getDimension(id);
      const goal = dim.getEntities({ type: "soccer:goal_red" })[0] ?? dim.getEntities({ type: "soccer:goal_blue" })[0];
      if (!goal || !goalFrame(goal)) continue;
      const center = centerFor(dim, goal);
      for (const ball of dim.getEntities({ type: BALL })) placeBall(ball, center);
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
  const target = npc.dimension.getEntities({ type: JP_ATTACK_GOAL })[0];
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
    const mates = npc.dimension
      .getEntities({ type: JP_PLAYER, location: npc.location, maxDistance: 16 })
      .filter((m) => m.id !== npc.id && horizontalDistance(m.location, mouth) < distance - 4);
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
  const goal = keeper.dimension.getEntities({ type: JP_DEFEND_GOAL })[0];
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
    const enemy = keeper.dimension.getEntities({ type: JP_ATTACK_GOAL })[0];
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
