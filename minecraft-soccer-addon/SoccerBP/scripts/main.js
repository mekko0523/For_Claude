import { world, system, DisplaySlotId, ItemStack } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { TEAMS } from "./teams.js";

// ===== 調整用の数値 =====
const SHOT_POWER = 1.2; // プレイヤーがボールを叩いたとき（シュート）の強さ
const SHOT_LIFT = 0.35; // シュートの浮き上がり（上を向くとさらに高く上がる）
const PASS_DISTANCE = 10; // スニーク中に叩いたとき（パス）に転がる距離
const PASS_LIFT = 0.12;
const POSSESS_RANGE = 1.5; // ボールにこれより近づくと、ボールを持つ（足元に吸い付く）
const KEEP_RANGE = 3.0; // ボールがこれより離れたら、ボールを失う
const FEET_DISTANCE = 0.9; // ドリブル中、ボールを体の前のどこに置くか
const DRIBBLE_PULL = 0.35; // ボールを足元へ引き寄せる強さ
const FREE_TICKS = 10; // 蹴った直後、ボールが足元に吸い付かない時間（tick）
const RESET_DELAY = 60; // ゴール後、ボールが戻るまでの時間（tick、20 = 1秒）

const NPC_DRIBBLE_POWER = 0.45;
const RETREAT_STEP = 0.35; // 自陣へ戻るとき、2tickごとに進む距離
const POSITION_STEP = 0.28; // ポジションへ動くとき、2tickごとに進む距離
const CHASER_SWITCH_MARGIN = 2; // 今追っている選手より、これだけ近い選手がいたら交代
const SHIFT_FORWARD = 0.4; // ボールの位置に合わせて、チーム全体が前後に動く量
const SHIFT_SIDE = 0.35; // ボールの位置に合わせて、チーム全体が左右に動く量

const KICK_RANGE = 2.2; // この距離以内にボールがあるとボタンで蹴れる
const PASS_CONE = 0.7; // パス相手を探す向きの幅（cos、0.7 ≒ 左右45度）
const SHOT_CONE = 0.35; // ゴールを自動で狙う向きの幅（cos、0.35 ≒ 左右70度）
const BUTTON_COOLDOWN = 6; // tick

// ===== 名前 =====
const BALL = "soccer:ball";
const NPC = "soccer:player";
const KEEPER = "soccer:keeper";
const BOOTS = "soccer:boots";
const WHISTLE = "soccer:whistle";
const PASS_ITEM = "soccer:pass";
const CROSS_ITEM = "soccer:cross";
const THROUGH_ITEM = "soccer:through";
const NET = "minecraft:iron_bars";
const DIMENSIONS = ["overworld", "nether", "the_end"];

// 青サイド＝青ゴールを守り赤ゴールを狙う（操作しているプレイヤーはいつも青サイド）
// 赤サイド＝赤ゴールを守り青ゴールを狙う
const SIDES = {
  blue: { color: "§9", defend: "soccer:goal_blue", attack: "soccer:goal_red", other: "red" },
  red: { color: "§c", defend: "soccer:goal_red", attack: "soccer:goal_blue", other: "blue" },
};
const GOALS = {
  "soccer:goal_red": { frame: "minecraft:red_concrete", name: "§c赤ゴール", side: "red" },
  "soccer:goal_blue": { frame: "minecraft:blue_concrete", name: "§9青ゴール", side: "blue" },
};

// 人数ごとに、どの選手（players の何番目）を出してどこに立たせるか
// 位置は [自陣ゴールからの距離の割合, 横の位置]
const PICKS = {
  4: [0, 6, 7, 9],
  7: [0, 1, 4, 6, 7, 8, 9],
  10: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
};
const FORMATIONS = {
  4: [[0.2, 0], [0.35, -8], [0.35, 8], [0.45, 0]],
  7: [[0.18, -5], [0.18, 5], [0.3, 0], [0.38, -10], [0.38, 10], [0.45, -4], [0.45, 4]],
  10: [
    [0.15, -4], [0.15, 4], [0.2, -11], [0.2, 11],
    [0.3, -5], [0.3, 5], [0.38, -11], [0.38, 11],
    [0.45, -4], [0.45, 4],
  ],
};
const SIZE_LABELS = { 4: "5人制（GK＋4人）", 7: "8人制（GK＋7人）", 10: "11人制（GK＋10人）※重め" };

// ===== 相手の強さ =====
// 味方（青サイド）はいつも「ふつう」。相手（赤サイド）はメニューで選ぶ
//   speed      : 走る速さの段階（tools/build.py の SPEEDS の何番目か。選手の「速さ」がこれに足される）
//   shootRange : 相手ゴールまでこの距離以内ならシュート
//   shotPower  : シュートの強さ
//   aim        : シュートのねらいの幅（2.5 より大きいと枠を外すことがある）
//   passChance : パスを出す確率
//   chaseEvery : ボールを追う選手を選び直す間隔（tick、小さいほど反応が速い）
//   press      : ボールがこの距離まで来たら、持ち場の選手も取りに行く
//   keeperReach / keeperRush / keeperSpeed : キーパーの届く距離・飛び出す距離・動く速さ
const DIFFICULTIES = [
  { label: "よわい", speed: 1, shootRange: 10, shotPower: 0.9, aim: 3.0, passChance: 0.2, chaseEvery: 20, press: 1.8, keeperReach: 1.2, keeperRush: 5, keeperSpeed: 0.2 },
  { label: "ふつう", speed: 3, shootRange: 14, shotPower: 1.1, aim: 1.8, passChance: 0.4, chaseEvery: 10, press: 2.5, keeperReach: 1.6, keeperRush: 7, keeperSpeed: 0.25 },
  { label: "つよい", speed: 5, shootRange: 18, shotPower: 1.35, aim: 1.6, passChance: 0.55, chaseEvery: 6, press: 3.5, keeperReach: 2.1, keeperRush: 9, keeperSpeed: 0.33 },
];

// 選手ごとの得意・不得意（tools/build.py の TEAMS で決める）
function npcStats(npc) {
  const t = team(tagValue(npc, "soccer_team_"));
  const i = Number(tagValue(npc, "soccer_pid") ?? -1);
  return t.players[i]?.stats ?? { spd: 0, sht: 0, pas: 0 };
}

function skill(side) {
  return DIFFICULTIES[side === "red" ? getMatch().difficulty ?? 1 : 1] ?? DIFFICULTIES[1];
}

// 向き: 0=南(+z) 1=西(-x) 2=北(-z) 3=東(+x)
const DIRS = [
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 0, z: -1 },
  { x: 1, z: 0 },
];

// ===== 共通 =====
function isValid(entity) {
  if (!entity) return false;
  return typeof entity.isValid === "function" ? entity.isValid() : entity.isValid;
}

function yawToDir(yaw) {
  return ((Math.round(yaw / 90) % 4) + 4) % 4;
}

function horizontalDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function team(key) {
  return TEAMS.find((t) => t.key === key) ?? TEAMS[0];
}

function tagValue(entity, prefix) {
  for (const tag of entity.getTags()) {
    if (tag.startsWith(prefix)) return tag.slice(prefix.length);
  }
  return undefined;
}

function sideOf(entity) {
  if (entity.typeId === "minecraft:player") return "blue";
  return tagValue(entity, "soccer_side_") ?? "blue";
}

// ===== 試合の設定（どの国どうし・何人制） =====
const MATCH = "soccer:match";

function getMatch() {
  try {
    const m = JSON.parse(world.getDynamicProperty(MATCH) ?? "");
    if (m.blue && m.red && PICKS[m.size]) return m;
  } catch {}
  return { blue: TEAMS[0].key, red: TEAMS[1].key, size: 4, difficulty: 1 };
}

function setMatch(m) {
  world.setDynamicProperty(MATCH, JSON.stringify(m));
}

function sideLabel(side) {
  return `${SIDES[side].color}${team(getMatch()[side]).name}`;
}

// ===== スコア =====
const OBJECTIVE = "soccer_score";

function getObjective() {
  let obj = world.scoreboard.getObjective(OBJECTIVE);
  if (!obj) {
    obj = world.scoreboard.addObjective(OBJECTIVE, "スコア");
    obj.setScore(sideLabel("blue"), 0);
    obj.setScore(sideLabel("red"), 0);
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

// 国が変わると表示名も変わるので、作り直す
function resetScores() {
  try {
    world.scoreboard.removeObjective(OBJECTIVE);
  } catch {}
  getObjective();
}

system.run(() => getObjective());

// ===== ゴール =====
function goalDir(goal) {
  const d = tagValue(goal, "soccer_dir");
  return d === undefined ? undefined : Number(d);
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

// ゴールの入口の中央（地面の高さ）
function goalMouth(goal) {
  const { base } = goalFrame(goal);
  return { x: base.x + 0.5, y: base.y, z: base.z + 0.5 };
}

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
  const at = (i, j, y) => ({ x: base.x + r.x * i + f.x * j, y: base.y + y, z: base.z + r.z * i + f.z * j });

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
  const goal = getGoals(dim).find((g) => g.typeId === type);
  return goal && goalFrame(goal) ? goal : undefined;
}

// ピッチの向き: 青ゴール(B) → 赤ゴール(R)
function pitch(dim) {
  const blue = findGoal(dim, "soccer:goal_blue");
  const red = findGoal(dim, "soccer:goal_red");
  if (!blue || !red) return undefined;
  const B = goalMouth(blue);
  const R = goalMouth(red);
  const length = horizontalDistance(B, R) || 1;
  const u = { x: (R.x - B.x) / length, z: (R.z - B.z) / length };
  return {
    B,
    R,
    length,
    u,
    v: { x: -u.z, z: u.x },
    center: { x: (B.x + R.x) / 2, y: Math.max(B.y, R.y) + 0.5, z: (B.z + R.z) / 2 },
  };
}

// サイドから見た「自陣ゴールからの距離の割合」と「横の位置」を座標にする
function slotPosition(p, side, frac, offset) {
  const own = side === "blue" ? p.B : p.R;
  const s = side === "blue" ? 1 : -1;
  return {
    x: own.x + s * (p.u.x * p.length * frac + p.v.x * offset),
    y: own.y,
    z: own.z + s * (p.u.z * p.length * frac + p.v.z * offset),
  };
}

// ===== ゴール判定・キックオフ =====
function centerFor(dimension, scoredGoal) {
  const p = pitch(dimension);
  if (p) return p.center;
  // ゴールが1つしかないときは、そのゴールの前（5ブロック手前）に戻す
  const { base, f } = goalFrame(scoredGoal);
  return { x: base.x + 0.5 - f.x * 5, y: base.y + 0.5, z: base.z + 0.5 - f.z * 5 };
}

function placeBall(ball, pos) {
  if (!isValid(ball)) return;
  freeBall(ball);
  ball.teleport(pos);
  ball.clearVelocity();
  ball.removeTag("soccer_scored");
}

// キックオフ: プレイヤーは青サイドのセンターサークルの外へ
function kickoffPositions(dim, center) {
  const p = pitch(dim);
  if (!p) return;
  dim.getPlayers({ location: center, maxDistance: 80 }).forEach((player, i) => {
    const side = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * 3;
    const spot = {
      x: center.x - p.u.x * 6 + p.v.x * side,
      y: center.y,
      z: center.z - p.u.z * 6 + p.v.z * side,
    };
    player.teleport(spot, { facingLocation: { x: center.x, y: center.y + 1, z: center.z } });
  });
}

function onGoal(ball, goal) {
  const scorer = SIDES[GOALS[goal.typeId].side].other; // 赤ゴールに入ったら青サイドの得点
  ball.addTag("soccer_scored");

  const obj = getObjective();
  obj.addScore(sideLabel(scorer), 1);
  const blue = getScore(obj, sideLabel("blue"));
  const red = getScore(obj, sideLabel("red"));

  for (const p of world.getAllPlayers()) {
    p.onScreenDisplay.setTitle("§eゴール！", {
      subtitle: `${sideLabel(scorer)}§rの得点！  ${sideLabel("blue")} ${blue}§r - ${SIDES.red.color}${red} ${sideLabel("red")}`,
      fadeInDuration: 5,
      stayDuration: 50,
      fadeOutDuration: 10,
    });
    try {
      p.playSound("random.levelup");
    } catch {}
  }

  // キックオフまで、それぞれ自陣へ戻る
  const center = centerFor(goal.dimension, goal);
  startRetreat(goal.dimension, RESET_DELAY + 20);
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

// ===== キック =====
// 蹴ったボールは、しばらく誰の足元にも吸い付かない（ドリブルが解ける）
const possession = new Map(); // プレイヤーの id → 持っているボールの id
const ballFreeUntil = new Map(); // ボールの id → 吸い付かなくなる時間

function freeBall(ball) {
  ballFreeUntil.set(ball.id, system.currentTick + FREE_TICKS);
  for (const [pid, bid] of possession) if (bid === ball.id) possession.delete(pid);
}

// マイクラの地面はすべりが悪く、蹴ったボールがすぐ止まってしまう。
// そこで蹴ったあとはスクリプトがボールを転がし、毎tick少しずつ遅くする（decay）。
// 転がる距離 ≒ 速さ ÷ (1 - decay) なので、届けたい距離から速さを決められる。
const ROLL_PASS = 0.94; // パス・クロス（約 速さ×17 ブロック転がる）
const ROLL_SHOT = 0.975; // シュート・クリア（遠くまで伸びる）
const ROLL_TOUCH = 0.85; // 選手のドリブルの小さなタッチ
const MAX_BALL_SPEED = 2.0;
const rolling = new Map(); // ボールの id → { ball, dir, speed, decay }

function launch(ball, dir, speed, lift, decay = ROLL_PASS) {
  speed = Math.min(MAX_BALL_SPEED, speed);
  freeBall(ball);
  ball.clearVelocity();
  ball.applyImpulse({ x: dir.x * speed, y: lift, z: dir.z * speed });
  rolling.set(ball.id, { ball, dir, speed, decay });
}

// distance ブロック先で止まる速さ
function speedFor(distance, decay = ROLL_PASS) {
  return Math.max(0.15, distance * (1 - decay));
}

function directionTo(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

function kickToward(ball, from, to, speed, lift, decay = ROLL_PASS) {
  launch(ball, directionTo(from, to), speed, lift, decay);
}

function kickInDirection(ball, dir, speed, lift, decay = ROLL_PASS) {
  launch(ball, dir, speed, lift, decay);
}

// to まで届くように蹴る（extra ブロックだけ少し先まで転がす）
function passTo(ball, to, lift, extra = 1.5) {
  const d = horizontalDistance(ball.location, to);
  launch(ball, directionTo(ball.location, to), speedFor(d + extra), lift, ROLL_PASS);
}

function isPossessed(ballId) {
  for (const bid of possession.values()) if (bid === ballId) return true;
  return false;
}

function rollTick() {
  for (const [id, r] of rolling) {
    const ball = r.ball;
    if (!isValid(ball) || ball.hasTag("soccer_scored") || isPossessed(id)) {
      rolling.delete(id);
      continue;
    }
    const v = ball.getVelocity();
    // 壁や人に当たって急に止まったら、転がしをやめる
    if (Math.hypot(v.x, v.z) < r.speed * 0.3) {
      rolling.delete(id);
      continue;
    }
    r.speed *= r.decay;
    if (r.speed < 0.04) {
      rolling.delete(id);
      continue;
    }
    ball.clearVelocity();
    ball.applyImpulse({ x: r.dir.x * r.speed, y: v.y, z: r.dir.z * r.speed });
  }
}

world.afterEvents.entityHitEntity.subscribe((ev) => {
  const ball = ev.hitEntity;
  const kicker = ev.damagingEntity;
  if (!ball || ball.typeId !== BALL || ball.hasTag("soccer_scored")) return;
  if (kicker?.typeId === NPC) {
    npcKick(ball, kicker);
    return;
  }
  if (!kicker || kicker.typeId !== "minecraft:player") return;

  const view = kicker.getViewDirection();
  const len = Math.hypot(view.x, view.z) || 1;
  const dir = { x: view.x / len, z: view.z / len };
  if (kicker.isSneaking) {
    kickInDirection(ball, dir, speedFor(PASS_DISTANCE), PASS_LIFT);
  } else {
    kickInDirection(ball, dir, SHOT_POWER, Math.min(0.9, Math.max(0.15, SHOT_LIFT + view.y * 0.6)), ROLL_SHOT);
  }
});

// ===== ドリブル: ボールを持っている間は、足元の前に吸い付く =====
function findBallById(player, id) {
  return player.dimension
    .getEntities({ type: BALL, location: player.location, maxDistance: KEEP_RANGE })
    .find((b) => b.id === id);
}

function isPossessedByOther(player, ball) {
  for (const [pid, bid] of possession) if (bid === ball.id && pid !== player.id) return true;
  return false;
}

function dribbleTick(player) {
  const now = system.currentTick;
  let ball;
  const id = possession.get(player.id);
  if (id !== undefined) {
    ball = findBallById(player, id);
    if (!ball || ball.hasTag("soccer_scored") || Math.abs(ball.location.y - player.location.y) > 2) {
      possession.delete(player.id);
      ball = undefined;
    }
  }
  if (!ball) {
    ball = player.dimension
      .getEntities({ type: BALL, location: player.location, maxDistance: POSSESS_RANGE + 1 })
      .find(
        (b) =>
          !b.hasTag("soccer_scored") &&
          (ballFreeUntil.get(b.id) ?? 0) <= now &&
          horizontalDistance(b.location, player.location) < POSSESS_RANGE &&
          Math.abs(b.location.y - player.location.y) < 1.5 &&
          !isPossessedByOther(player, b)
      );
    if (!ball) return;
    possession.set(player.id, ball.id);
  }

  // 体の前（動いている方向、止まっていれば向いている方向）へボールを運ぶ
  const dir = stickDirection(player);
  const pv = player.getVelocity();
  const bv = ball.getVelocity();
  const target = { x: player.location.x + dir.x * FEET_DISTANCE, z: player.location.z + dir.z * FEET_DISTANCE };
  ball.clearVelocity();
  ball.applyImpulse({
    x: pv.x + (target.x - ball.location.x) * DRIBBLE_PULL,
    y: Math.min(bv.y, 0),
    z: pv.z + (target.z - ball.location.z) * DRIBBLE_PULL,
  });
}

// 持っているボール（なければ近くのボール）
function controlledBall(player) {
  const id = possession.get(player.id);
  if (id !== undefined) {
    const ball = findBallById(player, id);
    if (ball && !ball.hasTag("soccer_scored")) return ball;
  }
  return nearestBall(player);
}

// ===== 選手（NPC） =====
// 同じサイドの味方（青サイドなら操作しているプレイヤーも味方）
function teammates(dim, side, location, maxDistance) {
  const mates = dim.getEntities({ type: NPC, tags: [`soccer_side_${side}`], location, maxDistance });
  if (side === "blue") mates.push(...dim.getPlayers({ location, maxDistance }));
  return mates;
}

// フィールドプレイヤーがボールに追いついたとき
function npcKick(ball, npc) {
  const side = sideOf(npc);
  const target = findGoal(npc.dimension, SIDES[side].attack);
  if (!target) {
    // 相手ゴールがないときは向いている方向へ蹴る
    const view = npc.getViewDirection();
    kickToward(ball, npc.location, { x: ball.location.x + view.x, z: ball.location.z + view.z }, NPC_DRIBBLE_POWER, 0.05, ROLL_TOUCH);
    return;
  }

  const { base, f, r } = goalFrame(target);
  const mouth = goalMouth(target);
  const distance = horizontalDistance(ball.location, mouth);

  const sk = skill(side);
  const st = npcStats(npc);
  if (distance <= sk.shootRange + st.sht * 2) {
    // シュート: ゴールの中のどこかを狙う（シュートが得意な選手ほど強く正確）
    const aim = (Math.random() * 2 - 1) * sk.aim * (1 - 0.15 * st.sht);
    const to = { x: base.x + 0.5 + f.x + r.x * aim, z: base.z + 0.5 + f.z + r.z * aim };
    kickToward(ball, ball.location, to, sk.shotPower * (1 + 0.08 * st.sht), 0.2 + Math.random() * 0.2, ROLL_SHOT);
    return;
  }

  // パス: 自分よりゴールに近い味方がいたら、ときどきパスを出す（パスが得意な選手ほどよく出し、正確）
  if (Math.random() < sk.passChance + 0.12 * st.pas) {
    const mates = teammates(npc.dimension, side, npc.location, 16).filter(
      (m) => m.id !== npc.id && horizontalDistance(m.location, mouth) < distance - 4
    );
    if (mates.length > 0) {
      const mate = mates[Math.floor(Math.random() * mates.length)];
      const miss = Math.max(0, 1.5 - st.pas * 0.75);
      const to = {
        x: mate.location.x + (Math.random() * 2 - 1) * miss,
        z: mate.location.z + (Math.random() * 2 - 1) * miss,
      };
      passTo(ball, to, 0.14);
      return;
    }
  }

  // ドリブル: ゴールの方向へ軽く蹴り出す
  kickToward(ball, ball.location, mouth, NPC_DRIBBLE_POWER, 0.05, ROLL_TOUCH);
}

// キーパー: ゴール前でボールとゴールの間に立ち、近づいたら飛び出してクリア
const keeperCooldown = new Map();

function keeperTick(keeper, balls) {
  const side = sideOf(keeper);
  const goal = findGoal(keeper.dimension, SIDES[side].defend);
  if (!goal || balls.length === 0) return;
  const { f, r } = goalFrame(goal);
  const mouth = goalMouth(goal);

  let ball = balls[0];
  for (const b of balls) {
    if (horizontalDistance(b.location, mouth) < horizontalDistance(ball.location, mouth)) ball = b;
  }
  const kp = keeper.location;
  const bp = ball.location;
  const sk = skill(side);
  const rushing = horizontalDistance(bp, mouth) < sk.keeperRush;

  // ボールに届いたらクリア（相手ゴールの方向へ大きく蹴る）
  const now = system.currentTick;
  if (
    !ball.hasTag("soccer_scored") &&
    horizontalDistance(kp, bp) < sk.keeperReach &&
    Math.abs(kp.y - bp.y) < 2 &&
    (keeperCooldown.get(keeper.id) ?? 0) <= now
  ) {
    keeperCooldown.set(keeper.id, now + 20);
    const enemy = findGoal(keeper.dimension, SIDES[side].attack);
    const to = enemy ? enemy.location : { x: mouth.x - f.x * 20, z: mouth.z - f.z * 20 };
    kickToward(ball, bp, to, 1.3, 0.6, ROLL_SHOT);
    return;
  }

  // 立つ位置を決める
  let spot;
  if (rushing && !ball.hasTag("soccer_scored")) {
    spot = { x: bp.x, z: bp.z }; // 飛び出す
  } else {
    const offset = (bp.x - mouth.x) * r.x + (bp.z - mouth.z) * r.z;
    const s = Math.max(-2, Math.min(2, offset * 0.3));
    spot = { x: mouth.x - f.x * 1.5 + r.x * s, z: mouth.z - f.z * 1.5 + r.z * s };
  }
  stepToward(keeper, spot, rushing ? sk.keeperSpeed * 1.6 : sk.keeperSpeed, bp);
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

// 少しずつテレポートして歩かせる（壁や段差に埋まらないよう、空いているときだけ進む）
function stepToward(entity, spot, maxStep, look) {
  const p = entity.location;
  const dx = spot.x - p.x;
  const dz = spot.z - p.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.1) return;
  const step = Math.min(dist, maxStep);
  const next = { x: p.x + (dx / dist) * step, y: p.y, z: p.z + (dz / dist) * step };
  const dim = entity.dimension;
  if (!isPassable(dim, next) || !isPassable(dim, { x: next.x, y: next.y + 1, z: next.z })) return;
  entity.teleport(next, { facingLocation: { x: look.x, y: p.y + 1.5, z: look.z } });
}

// ===== 戻り（リトリート）: ゴールが決まったら、キックオフまでそれぞれ自陣へ戻る =====
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
  for (const npc of dim.getEntities({ type: NPC })) setChasing(npc, false);
}

function npcSlot(npc) {
  const size = Number(tagValue(npc, "soccer_size") ?? 10);
  const slot = Number(tagValue(npc, "soccer_slot") ?? 0);
  return (FORMATIONS[size] ?? FORMATIONS[10])[slot] ?? [0.3, 0];
}

function retreatTick(dim, balls) {
  const until = retreatUntil.get(dim.id);
  if (until === undefined) return;
  const npcs = dim.getEntities({ type: NPC });
  if (system.currentTick >= until) {
    retreatUntil.delete(dim.id); // ここからはポジションの動き（positionTick）に戻る
    return;
  }
  const p = pitch(dim);
  if (!p) return;
  const look = balls[0]?.location ?? p.center;
  for (const npc of npcs) {
    const [frac, offset] = npcSlot(npc);
    stepToward(npc, slotPosition(p, sideOf(npc), frac, offset), RETREAT_STEP, look);
  }
}

// ===== ポジション: ボールを追うのは各チーム1人だけ、ほかは自分の持ち場を守る =====
const chasers = new Map(); // "ディメンション:サイド" → 追っている選手の id

// ボールが自陣ゴールからどれだけ進んだか（0〜1）と、横のずれ（そのサイドから見た向き）
function ballInSideFrame(p, side, ball) {
  const s = side === "blue" ? 1 : -1;
  const dx = ball.x - p.center.x;
  const dz = ball.z - p.center.z;
  const along = (dx * p.u.x + dz * p.u.z) * s; // センターから相手ゴール方向へ
  return { frac: 0.5 + along / p.length, offset: (dx * p.v.x + dz * p.v.z) * s };
}

// 持ち場: フォーメーションの位置を、ボールの位置に合わせてずらす
function positionTarget(p, npc, ballFrame) {
  const [frac, offset] = npcSlot(npc);
  const f = Math.max(0.05, Math.min(0.9, frac + (ballFrame.frac - 0.35) * SHIFT_FORWARD * 1.5));
  return slotPosition(p, sideOf(npc), f, offset + ballFrame.offset * SHIFT_SIDE);
}

function pickChaser(dim, side, npcs, ball) {
  const key = `${dim.id}:${side}`;
  let nearest;
  let nearestDist = Infinity;
  for (const npc of npcs) {
    const d = horizontalDistance(npc.location, ball.location);
    if (d < nearestDist) {
      nearest = npc;
      nearestDist = d;
    }
  }
  // 自分（プレイヤー）がボールの近くにいるときは、味方はボールを取りに来ない
  if (side === "blue") {
    for (const player of dim.getPlayers({ location: ball.location, maxDistance: 4 })) {
      if (horizontalDistance(player.location, ball.location) < nearestDist) {
        chasers.delete(key);
        return undefined;
      }
    }
  }
  // 交代が多すぎてバタバタしないよう、今の選手がそこそこ近ければそのまま
  const current = npcs.find((n) => n.id === chasers.get(key));
  if (current && horizontalDistance(current.location, ball.location) < nearestDist + CHASER_SWITCH_MARGIN) return current;
  if (nearest) chasers.set(key, nearest.id);
  return nearest;
}

function positionTick(dim, balls) {
  if (retreatUntil.has(dim.id)) return;
  const p = pitch(dim);
  const ball = balls.find((b) => !b.hasTag("soccer_scored"));
  if (!p || !ball) return;
  for (const side of ["blue", "red"]) {
    const sk = skill(side);
    const reselect = system.currentTick % sk.chaseEvery < 2;
    const npcs = dim.getEntities({ type: NPC, tags: [`soccer_side_${side}`] });
    if (npcs.length === 0) continue;
    const key = `${dim.id}:${side}`;
    const chaser = reselect ? pickChaser(dim, side, npcs, ball) : npcs.find((n) => n.id === chasers.get(key));
    const frame = ballInSideFrame(p, side, ball.location);

    for (const npc of npcs) {
      const close = horizontalDistance(npc.location, ball.location) < sk.press;
      if (npc === chaser || close) {
        setChasing(npc, true);
      } else {
        setChasing(npc, false);
        stepToward(npc, positionTarget(p, npc, frame), POSITION_STEP, ball.location);
      }
    }
  }
}

// ===== 毎tickの処理 =====
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
    for (const keeper of dim.getEntities({ type: KEEPER })) keeperTick(keeper, balls);
    retreatTick(dim, balls);
    positionTick(dim, balls);
    for (const ball of balls) {
      if (ball.hasTag("soccer_scored")) continue;
      checkGoal(ball, goals);
    }
  }
}, 2);

// ===== 試合を始める =====
function clearTeams(dim) {
  for (const type of [NPC, KEEPER]) for (const e of dim.getEntities({ type })) e.remove();
}

function spawnTeam(dim, p, side, teamKey, size) {
  const t = team(teamKey);
  PICKS[size].forEach((index, slot) => {
    const [frac, offset] = FORMATIONS[size][slot];
    const pos = slotPosition(p, side, frac, offset);
    const npc = dim.spawnEntity(NPC, { x: pos.x, y: pos.y + 0.1, z: pos.z });
    npc.triggerEvent(`soccer:v${t.fieldVariantBase + index}`);
    const info = t.players[index];
    npc.triggerEvent(`soccer:speed${Math.max(0, Math.min(6, skill(side).speed + info.stats.spd))}`);
    for (const tag of [`soccer_side_${side}`, `soccer_team_${t.key}`, `soccer_slot${slot}`, `soccer_size${size}`, `soccer_pid${index}`])
      npc.addTag(tag);
    npc.nameTag = `${SIDES[side].color}${info.num} ${info.name}`;
  });

  const gk = slotPosition(p, side, 0, 0);
  const s = side === "blue" ? 1 : -1;
  const keeper = dim.spawnEntity(KEEPER, { x: gk.x + p.u.x * s * 1.5, y: gk.y + 0.1, z: gk.z + p.u.z * s * 1.5 });
  keeper.triggerEvent(`soccer:v${t.keeperVariant}`);
  keeper.addTag(`soccer_side_${side}`);
  keeper.addTag(`soccer_team_${t.key}`);
  keeper.nameTag = `${SIDES[side].color}${t.keeper.num} ${t.keeper.name}`;
}

function startMatch(player, blueKey, redKey, size, difficulty = 1) {
  const dim = player.dimension;
  const p = pitch(dim);
  if (!p) {
    player.sendMessage("§c赤ゴールと青ゴールの両方が必要です。スタジアムを建てるか、ゴールを置いてください");
    return;
  }
  setMatch({ blue: blueKey, red: redKey, size, difficulty });
  clearTeams(dim);
  resetScores();
  retreatUntil.delete(dim.id);
  spawnTeam(dim, p, "blue", blueKey, size);
  spawnTeam(dim, p, "red", redKey, size);

  const balls = dim.getEntities({ type: BALL });
  if (balls.length === 0) dim.spawnEntity(BALL, p.center);
  for (const ball of balls) placeBall(ball, p.center);
  kickoffPositions(dim, p.center);

  for (const pl of world.getAllPlayers()) {
    pl.onScreenDisplay.setTitle("§eキックオフ！", {
      subtitle: `${sideLabel("blue")}§r vs ${sideLabel("red")}`,
      fadeInDuration: 5,
      stayDuration: 50,
      fadeOutDuration: 10,
    });
  }
}

// ===== 試合メニュー（ホイッスルを「使う」） =====
async function showForm(player, form) {
  // チャット画面などが開いていると表示できないので、少し待ってやり直す
  for (let i = 0; i < 20; i++) {
    const res = await form.show(player);
    if (res.cancelationReason !== "UserBusy") return res;
    await new Promise((resolve) => system.runTimeout(resolve, 10));
  }
  return { canceled: true };
}

async function chooseTeam(player, title, exclude) {
  const choices = TEAMS.filter((t) => t.key !== exclude);
  const form = new ActionFormData().title(title);
  for (const t of choices) form.button(t.name);
  const res = await showForm(player, form);
  if (res.canceled) return undefined;
  return choices[res.selection]?.key;
}

async function openMatchSetup(player) {
  const mine = await chooseTeam(player, "あなたのチーム（青サイド）", undefined);
  if (!mine) return;
  const rival = await chooseTeam(player, "相手チーム（赤サイド）", mine);
  if (!rival) return;
  const sizes = [4, 7, 10];
  const form = new ActionFormData().title("人数");
  for (const s of sizes) form.button(SIZE_LABELS[s]);
  const res = await showForm(player, form);
  if (res.canceled) return;
  const level = new ActionFormData().title("相手の強さ");
  for (const d of DIFFICULTIES) level.button(d.label);
  const lv = await showForm(player, level);
  if (lv.canceled) return;
  startMatch(player, mine, rival, sizes[res.selection], lv.selection);
}

async function openMenu(player) {
  const m = getMatch();
  const form = new ActionFormData()
    .title("サッカー メニュー")
    .body(
      `いまの試合: ${sideLabel("blue")}§r vs ${sideLabel("red")}§r（${SIZE_LABELS[m.size]}・相手は${DIFFICULTIES[m.difficulty ?? 1].label}）`
    )
    .button("試合を始める（国と人数を選ぶ）")
    .button("同じ組み合わせでもう一度")
    .button("キックオフに戻す（スコアはそのまま）")
    .button("選手を片付ける");
  const res = await showForm(player, form);
  if (res.canceled) return;
  if (res.selection === 0) await openMatchSetup(player);
  else if (res.selection === 1) startMatch(player, m.blue, m.red, m.size, m.difficulty ?? 1);
  else if (res.selection === 2) {
    const p = pitch(player.dimension);
    if (!p) return;
    for (const ball of player.dimension.getEntities({ type: BALL })) placeBall(ball, p.center);
    startRetreat(player.dimension, 60);
    kickoffPositions(player.dimension, p.center);
  } else if (res.selection === 3) {
    clearTeams(player.dimension);
    player.sendMessage("§e選手を片付けました");
  }
}

// ===== コントローラー操作（FC風） =====
// マイクラの操作を次のサッカーの動きに割り当てる（ボタンの割り当てはマイクラの設定で変える）
//   ジャンプ         → パス（近くの味方へ自動で狙う）
//   使う（シューズ） → シュート（相手ゴールの方を向いていれば自動で狙う）
//   スニーク         → ロブパス／クロス（浮き球）
//   アイテムを捨てる → スルーパス（味方の前のスペースへ）
//   スプリント       → ダッシュ（マイクラの通常のダッシュ）
//   使う（ホイッスル）→ 試合メニュー
// ホットバーのアイテムを「使う」でも発動できる: パス／クロス／スルーパス
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
  for (const mate of teammates(player.dimension, "blue", ball.location, 32)) {
    if (mate.id === player.id) continue;
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

function doPass(player) {
  const ball = controlledBall(player);
  if (!ball || !canKick(player)) return;
  const dir = stickDirection(player);
  const mate = findMate(player, ball, dir);
  if (mate) {
    passTo(ball, mate.location, 0.12);
  } else {
    kickInDirection(ball, dir, speedFor(12), 0.12);
  }
}

function doLob(player) {
  const ball = controlledBall(player);
  if (!ball || !canKick(player)) return;
  const dir = stickDirection(player);
  const mate = findMate(player, ball, dir);
  if (mate) {
    // 遠い味方ほど高く上げる
    const d = horizontalDistance(ball.location, mate.location);
    passTo(ball, mate.location, Math.min(0.8, 0.4 + d * 0.012), 2);
  } else {
    kickInDirection(ball, dir, speedFor(16), 0.6);
  }
}

function doThroughPass(player) {
  const ball = controlledBall(player);
  if (!ball || !canKick(player)) return;
  const dir = stickDirection(player);
  const mate = findMate(player, ball, dir);
  if (!mate) {
    kickInDirection(ball, dir, speedFor(16), 0.1);
    return;
  }
  // 味方の少し前（相手ゴール側、なければパスの方向）へ出す
  const goal = findGoal(player.dimension, SIDES.blue.attack);
  let ahead = dir;
  if (goal) {
    const mouth = goalMouth(goal);
    const gx = mouth.x - mate.location.x;
    const gz = mouth.z - mate.location.z;
    const len = Math.hypot(gx, gz) || 1;
    ahead = { x: gx / len, z: gz / len };
  }
  const spot = { x: mate.location.x + ahead.x * 4, z: mate.location.z + ahead.z * 4 };
  passTo(ball, spot, 0.1, 1.5);
}

function doShot(player) {
  const ball = controlledBall(player);
  if (!ball || !canKick(player)) return;
  const dir = stickDirection(player);
  const goal = findGoal(player.dimension, SIDES.blue.attack);
  if (goal) {
    const { base, f, r } = goalFrame(goal);
    const mouth = goalMouth(goal);
    const gx = mouth.x - ball.location.x;
    const gz = mouth.z - ball.location.z;
    const gd = Math.hypot(gx, gz) || 1;
    if ((gx * dir.x + gz * dir.z) / gd > SHOT_CONE) {
      // ゴールの方を向いていたら、スティックの向きに近いほうのサイドを狙う
      const side = Math.max(-1.8, Math.min(1.8, (dir.x * r.x + dir.z * r.z) * 6));
      const to = { x: base.x + 0.5 + f.x + r.x * side, z: base.z + 0.5 + f.z + r.z * side };
      kickToward(ball, ball.location, to, 1.4, Math.min(0.45, 0.2 + gd * 0.01), ROLL_SHOT);
      return;
    }
  }
  kickInDirection(ball, dir, 1.3, 0.3, ROLL_SHOT);
}

// アイテムを「使う」: シューズ＝シュート、パス、クロス、スルーパス、ホイッスル＝メニュー
// （使えたかどうかに関係なく反応するよう before と after の両方で受ける。二重にはならない）
const lastItemUse = new Map();
const ITEM_ACTIONS = {
  [BOOTS]: doShot,
  [PASS_ITEM]: doPass,
  [CROSS_ITEM]: doLob,
  [THROUGH_ITEM]: doThroughPass,
  [WHISTLE]: openMenu,
};

function onItemUse(player, id) {
  if (!player || player.typeId !== "minecraft:player") return;
  const now = system.currentTick;
  if ((lastItemUse.get(player.id) ?? -10) > now - 4) return;
  lastItemUse.set(player.id, now);
  ITEM_ACTIONS[id]?.(player);
}

world.afterEvents.itemUse.subscribe((ev) => onItemUse(ev.source, ev.itemStack?.typeId));
world.beforeEvents?.itemUse?.subscribe((ev) => {
  const player = ev.source;
  const id = ev.itemStack?.typeId;
  if (ITEM_ACTIONS[id]) system.run(() => onItemUse(player, id));
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
  giveItem(player, BOOTS, player.selectedSlotIndex ?? player.selectedSlot);
  doThroughPass(player);
});

function hasItem(inv, id) {
  for (let i = 0; i < inv.size; i++) {
    if (inv.getItem(i)?.typeId === id) return true;
  }
  return false;
}

// 持っていなければ渡す。slot が空いていればそこ（ホットバーの決まった場所）に置く
function giveItem(player, id, slot) {
  const inv = player.getComponent("minecraft:inventory")?.container;
  if (!inv || hasItem(inv, id)) return;
  if (slot !== undefined && !inv.getItem(slot)) inv.setItem(slot, new ItemStack(id, 1));
  else inv.addItem(new ItemStack(id, 1));
}

// ホットバー: 1=シュート 2=パス 3=クロス 4=スルーパス 9=ホイッスル
function giveSoccerItems(player) {
  giveItem(player, BOOTS, 0);
  giveItem(player, PASS_ITEM, 1);
  giveItem(player, CROSS_ITEM, 2);
  giveItem(player, THROUGH_ITEM, 3);
  giveItem(player, WHISTLE, 8);
}

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
    dribbleTick(player);
  }
  rollTick();
}, 1);

// 手に持っているサッカーのアイテムを、画面下に大きく表示する（ホットバーで見分けやすく）
const HELD_LABELS = {
  [BOOTS]: "§b■ シュート",
  [PASS_ITEM]: "§a■ パス",
  [CROSS_ITEM]: "§e■ クロス／ロブ",
  [THROUGH_ITEM]: "§9■ スルーパス",
  [WHISTLE]: "§f■ ホイッスル（メニュー）",
};

system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    const inv = player.getComponent("minecraft:inventory")?.container;
    const slot = player.selectedSlotIndex ?? player.selectedSlot;
    if (!inv || slot === undefined) continue;
    const label = HELD_LABELS[inv.getItem(slot)?.typeId];
    if (label) player.onScreenDisplay.setActionBar(label);
  }
}, 10);

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

function buildStadium(dim, loc, dir, onDone) {
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
    onDone?.(players);
  }, 1);
}

function finishStadium(dim, at, dir, players) {
  const center = (u, v) => {
    const p = at(u, v, 1);
    return { x: p.x + 0.5, y: p.y, z: p.z + 0.5 };
  };
  // 奥（向いている方向）が赤ゴール＝青サイドが攻めるゴール、手前が青ゴール
  placeGoal(dim.spawnEntity("soccer:goal_red", center(HALF_LENGTH, 0)), dir);
  placeGoal(dim.spawnEntity("soccer:goal_blue", center(-HALF_LENGTH, 0)), (dir + 2) % 4);

  const kickoff = center(0, 0);
  const balls = dim.getEntities({ type: BALL });
  if (balls.length === 0) dim.spawnEntity(BALL, kickoff);
  for (const ball of balls) placeBall(ball, kickoff);

  const start = center(-6, 0);
  // ワールドの出現地点（リスポーン地点）をピッチの上にする
  try {
    world.setDefaultSpawnLocation({ x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) });
  } catch {}
  for (const p of players) {
    if (!isValid(p)) continue;
    p.teleport(start, { facingLocation: { x: kickoff.x, y: kickoff.y + 1, z: kickoff.z } });
    p.sendMessage("§aスタジアムが完成しました！");
  }
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
  if (!ev.initialSpawn) return;
  const player = ev.player;
  system.runTimeout(() => {
    if (isValid(player)) giveSoccerItems(player);
  }, 20);

  if (world.getDynamicProperty(STADIUM_BUILT)) return;
  world.setDynamicProperty(STADIUM_BUILT, true);
  // 遊んでいる途中のワールドに後からアドオンを入れたときは、建物を壊さないように自動では建てない
  if (worldAge() > NEW_WORLD_TICKS) {
    player.sendMessage("§eスタジアムを建てるときは §f/scriptevent soccer:stadium §eと入力してください");
    return;
  }
  // まわりの地形が読み込まれるのを少し待ってから建て、できたら試合の国を選んでもらう
  system.runTimeout(() => {
    if (!isValid(player)) return;
    buildStadium(player.dimension, player.location, yawToDir(player.getRotation().y), () => {
      if (isValid(player)) openMatchSetup(player);
    });
  }, 60);
});

// ===== コマンド =====
// /scriptevent soccer:menu    … 試合メニューを開く（ホイッスルを使うのと同じ）
// /scriptevent soccer:reset   … スコアを0に戻してキックオフ
// /scriptevent soccer:clear   … ボール・選手・ゴールの目印を消す（ブロックは残る）
// /scriptevent soccer:items   … サッカーシューズとホイッスルをもらう
// /scriptevent soccer:stadium … 目の前にスタジアムを建てる
system.afterEvents.scriptEventReceive.subscribe((ev) => {
  const source = ev.sourceEntity?.typeId === "minecraft:player" ? ev.sourceEntity : world.getAllPlayers()[0];
  if (ev.id === "soccer:menu") {
    if (source) openMenu(source);
  } else if (ev.id === "soccer:reset") {
    resetScores();
    for (const id of DIMENSIONS) {
      const dim = world.getDimension(id);
      const p = pitch(dim);
      if (!p) continue;
      for (const ball of dim.getEntities({ type: BALL })) placeBall(ball, p.center);
      startRetreat(dim, 60);
      kickoffPositions(dim, p.center);
    }
    world.sendMessage("§eスコアをリセットしました。キックオフ！");
  } else if (ev.id === "soccer:clear") {
    for (const id of DIMENSIONS) {
      const dim = world.getDimension(id);
      for (const type of [BALL, NPC, KEEPER, ...Object.keys(GOALS)]) {
        for (const e of dim.getEntities({ type })) e.remove();
      }
    }
    goalCache.clear();
    world.sendMessage("§eボール・選手・ゴールの目印を消しました。");
  } else if (ev.id === "soccer:items") {
    if (source) giveSoccerItems(source);
  } else if (ev.id === "soccer:stadium") {
    if (source) buildStadium(source.dimension, source.location, yawToDir(source.getRotation().y));
  }
});
