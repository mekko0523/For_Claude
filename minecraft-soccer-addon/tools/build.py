"""サッカーアドオンのビルドスクリプト

チーム（国）のデータから、選手のテクスチャ・エンティティ定義・scripts/teams.js を作り、
パックのバージョンと名前をそろえて SoccerAddon_v<VERSION>.mcaddon にまとめる。

国を追加するときは TEAMS に1つ足して `python3 tools/build.py` を実行する。
"""

import json
import os
import zipfile

from PIL import Image

VERSION = [1, 8, 0]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BP = os.path.join(ROOT, "SoccerBP")
RP = os.path.join(ROOT, "SoccerRP")

# ===== 色 =====
WHITE = (240, 240, 240, 255)
BLACK = (25, 25, 25, 255)
SKIN = {
    "light": (240, 200, 170, 255),
    "fair": (234, 192, 160, 255),
    "medium": (225, 180, 145, 255),
    "tan": (200, 150, 110, 255),
    "brown": (140, 95, 70, 255),
    "dark": (105, 70, 50, 255),
}
HAIR = {
    "black": (20, 18, 18, 255),
    "darkbrown": (45, 30, 22, 255),
    "brown": (70, 45, 30, 255),
}
# 髪型: side=横の髪の長さ, back_short=後ろを短く, bangs=前髪（顔の8列それぞれの長さ）
STYLES = {
    "short": {"side": 1, "back_short": 2, "bangs": [1, 1, 1, 1, 1, 1, 1, 1]},
    "normal": {"side": 2, "back_short": 0, "bangs": [2, 2, 1, 1, 1, 1, 2, 2]},
    "long": {"side": 3, "back_short": 0, "bangs": [3, 2, 2, 2, 2, 2, 2, 3]},
    "parted": {"side": 2, "back_short": 0, "bangs": [2, 3, 2, 1, 1, 2, 3, 2]},
    "side": {"side": 3, "back_short": 0, "bangs": [3, 3, 3, 2, 1, 1, 2, 3]},
    "curly": {"side": 4, "back_short": 0, "bangs": [3, 3, 2, 2, 2, 2, 3, 3]},
}

# ===== チーム =====
# players はフィールドプレイヤー10人。並び順は DF(CB,CB,LB,RB) → MF(4人) → FW(2人)
# （scripts の PICKS / FORMATIONS がこの並び順を前提にしている）
TEAMS = [
    {
        "key": "japan",
        "name": "日本",
        "kit": {"shirt": (30, 63, 175, 255), "shorts": WHITE, "socks": (30, 63, 175, 255), "number": WHITE},
        "keeper_kit": {"shirt": (232, 208, 32, 255), "shorts": (40, 40, 40, 255), "socks": (232, 208, 32, 255), "number": BLACK},
        # 背番号は W杯2026（北中米大会）のもの
        "players": [
            (4, "板倉滉", "fair", "black", "normal"),
            (22, "冨安健洋", "medium", "black", "long"),
            (21, "伊藤洋輝", "light", "darkbrown", "short"),
            (2, "菅原由勢", "fair", "brown", "parted"),
            (7, "田中碧", "medium", "darkbrown", "side"),
            (15, "鎌田大地", "light", "black", "normal"),
            (8, "久保建英", "fair", "black", "long"),
            (10, "堂安律", "medium", "darkbrown", "short"),
            (14, "伊東純也", "light", "black", "parted"),
            (18, "上田綺世", "fair", "black", "side"),
        ],
        "keeper": (1, "鈴木彩艶", "brown", "black", "short"),
    },
    {
        "key": "spain",
        "name": "スペイン",
        "kit": {"shirt": (200, 25, 35, 255), "shorts": (25, 35, 95, 255), "socks": (200, 25, 35, 255), "number": (240, 200, 40, 255)},
        "keeper_kit": {"shirt": (40, 160, 80, 255), "shorts": (30, 30, 30, 255), "socks": (40, 160, 80, 255), "number": BLACK},
        # 背番号は W杯2026（北中米大会）のもの
        "players": [
            (22, "クバルシ", "light", "darkbrown", "normal"),
            (14, "ラポルテ", "light", "brown", "short"),
            (24, "ククレジャ", "light", "darkbrown", "curly"),
            (12, "ペドロ・ポロ", "tan", "black", "short"),
            (16, "ロドリ", "light", "darkbrown", "short"),
            (8, "ファビアン・ルイス", "light", "darkbrown", "long"),
            (20, "ペドリ", "light", "black", "normal"),
            (10, "ダニ・オルモ", "light", "darkbrown", "parted"),
            (17, "ニコ・ウィリアムズ", "dark", "black", "short"),
            (19, "ラミン・ヤマル", "brown", "black", "curly"),
        ],
        "keeper": (1, "ダビド・ラヤ", "light", "darkbrown", "short"),
    },
]

FONT = {
    "0": ["111", "101", "101", "101", "111"],
    "1": ["010", "110", "010", "010", "111"],
    "2": ["111", "001", "111", "100", "111"],
    "3": ["111", "001", "111", "001", "111"],
    "4": ["101", "101", "111", "001", "001"],
    "5": ["111", "100", "111", "001", "111"],
    "6": ["111", "100", "111", "101", "111"],
    "7": ["111", "001", "010", "010", "010"],
    "8": ["111", "101", "111", "101", "111"],
    "9": ["111", "101", "111", "001", "111"],
}


def make_skin(num, kit, skin_key, hair_key, style_key):
    """64x64 の人型スキンを作る（頭・体・腕・脚のボックスUV）"""
    shirt, shorts, socks, numcol = kit["shirt"], kit["shorts"], kit["socks"], kit["number"]
    skin, hair, style = SKIN[skin_key], HAIR[hair_key], STYLES[style_key]
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))

    def rect(x0, y0, x1, y1, c):
        for y in range(y0, y1):
            for x in range(x0, x1):
                img.putpixel((x, y), c)

    def box(u, v, w, h, d, row_color, top, bottom):
        rect(u + d, v, u + d + w, v + d, top)
        rect(u + d + w, v, u + d + 2 * w, v + d, bottom)
        for r in range(h):
            rect(u, v + d + r, u + 2 * (d + w), v + d + r + 1, row_color(r))

    def digits(s, x, y):
        for ch in s:
            for yy, row in enumerate(FONT[ch]):
                for xx, b in enumerate(row):
                    if b == "1":
                        img.putpixel((x + xx, y + yy), numcol)
            x += 4

    # 頭
    box(0, 0, 8, 8, 8, lambda r: skin, hair, skin)
    rect(0, 8, 32, 8 + style["side"], hair)
    rect(24, 8, 32, 16 - style["back_short"], hair)
    for x in range(8, 16):
        rect(x, 8, x + 1, 8 + style["bangs"][x - 8], hair)
    for ex in (10, 13):
        img.putpixel((ex, 12), WHITE)
        img.putpixel((ex, 13), BLACK)
    rect(11, 14, 13, 15, (150, 70, 60, 255))
    # 体（シャツ）と背番号
    box(16, 16, 8, 12, 4, lambda r: shirt, shirt, shirt)
    rect(23, 20, 25, 21, WHITE if shirt != WHITE else BLACK)
    s = str(num)
    digits(s, 32 + (8 - (len(s) * 4 - 1)) // 2, 22)
    if len(s) == 1:
        digits(s, 25, 22)
    # 腕（袖4段＋肌）
    arm = lambda r: shirt if r < 4 else skin
    box(40, 16, 4, 12, 4, arm, shirt, skin)
    box(32, 48, 4, 12, 4, arm, shirt, skin)

    # 脚（パンツ5段・肌1段・ソックス・靴2段）
    def leg(r):
        if r < 5:
            return shorts
        if r < 6:
            return skin
        if r < 10:
            return socks
        return BLACK

    box(0, 16, 4, 12, 4, leg, shorts, BLACK)
    box(16, 48, 4, 12, 4, leg, shorts, BLACK)
    return img


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def build_textures():
    tex = os.path.join(RP, "textures", "entity")
    os.makedirs(tex, exist_ok=True)
    for team in TEAMS:
        for i, (num, _name, skin, hair, style) in enumerate(team["players"]):
            make_skin(num, team["kit"], skin, hair, style).save(os.path.join(tex, f"player_{team['key']}_{i}.png"))
        num, _name, skin, hair, style = team["keeper"]
        make_skin(num, team["keeper_kit"], skin, hair, style).save(os.path.join(tex, f"keeper_{team['key']}.png"))


NO_DAMAGE = {"triggers": [{"cause": "all", "deals_damage": False}]}


def npc_components():
    return {
        "minecraft:type_family": {"family": ["soccer_player", "mob"]},
        "minecraft:collision_box": {"width": 0.6, "height": 1.8},
        "minecraft:health": {"value": 20, "max": 20},
        "minecraft:damage_sensor": NO_DAMAGE,
        "minecraft:knockback_resistance": {"value": 1.0},
        "minecraft:physics": {},
        "minecraft:pushable": {"is_pushable": True, "is_pushable_by_piston": True},
        "minecraft:nameable": {"always_show": True, "allow_name_tag_renaming": False},
        "minecraft:movement": {"value": 0.28},
        "minecraft:movement.basic": {},
        "minecraft:jump.static": {},
        "minecraft:navigation.walk": {"avoid_water": True, "can_path_over_water": False},
        "minecraft:behavior.look_at_player": {"priority": 8, "look_distance": 8},
        "minecraft:behavior.random_look_around": {"priority": 9},
    }


def build_entities():
    field_variants = len(TEAMS) * 10

    # フィールドプレイヤー: ボールを追いかける（chase）を付け外しできる
    groups = {f"soccer:v{i}": {"minecraft:variant": {"value": i}} for i in range(field_variants)}
    groups["soccer:chase"] = {
        "minecraft:attack": {"damage": 1},
        "minecraft:behavior.melee_attack": {"priority": 2, "speed_multiplier": 1.25, "track_target": False},
        "minecraft:behavior.nearest_attackable_target": {
            "priority": 1,
            "must_see": False,
            "reselect_targets": True,
            "within_radius": 40,
            "scan_interval": 10,
            "entity_types": [
                {"filters": {"test": "is_family", "subject": "other", "value": "soccer_ball"}, "max_dist": 40}
            ],
        },
    }
    events = {f"soccer:v{i}": {"add": {"component_groups": [f"soccer:v{i}"]}} for i in range(field_variants)}
    events["minecraft:entity_spawned"] = {"add": {"component_groups": ["soccer:chase"]}}
    events["soccer:chase_on"] = {"add": {"component_groups": ["soccer:chase"]}}
    events["soccer:chase_off"] = {"remove": {"component_groups": ["soccer:chase"]}}
    write_json(
        os.path.join(BP, "entities", "player.json"),
        {
            "format_version": "1.16.0",
            "minecraft:entity": {
                "description": {"identifier": "soccer:player", "is_spawnable": False, "is_summonable": True, "is_experimental": False},
                "component_groups": groups,
                "components": npc_components(),
                "events": events,
            },
        },
    )

    # キーパー: 動きはスクリプトが決める
    kgroups = {f"soccer:v{i}": {"minecraft:variant": {"value": i}} for i in range(len(TEAMS))}
    kevents = {f"soccer:v{i}": {"add": {"component_groups": [f"soccer:v{i}"]}} for i in range(len(TEAMS))}
    write_json(
        os.path.join(BP, "entities", "keeper.json"),
        {
            "format_version": "1.16.0",
            "minecraft:entity": {
                "description": {"identifier": "soccer:keeper", "is_spawnable": False, "is_summonable": True, "is_experimental": False},
                "component_groups": kgroups,
                "components": npc_components(),
                "events": kevents,
            },
        },
    )

    # リソース側: variant でテクスチャを選ぶ
    field_tex = {}
    for t, team in enumerate(TEAMS):
        for i in range(10):
            field_tex[f"v{t * 10 + i}"] = f"textures/entity/player_{team['key']}_{i}"
    keeper_tex = {f"v{t}": f"textures/entity/keeper_{team['key']}" for t, team in enumerate(TEAMS)}

    write_json(
        os.path.join(RP, "render_controllers", "soccer_player.render_controllers.json"),
        {
            "format_version": "1.8.0",
            "render_controllers": {
                "controller.render.soccer_player": {
                    "arrays": {"textures": {"Array.skins": [f"Texture.v{i}" for i in range(field_variants)]}},
                    "geometry": "Geometry.default",
                    "materials": [{"*": "Material.default"}],
                    "textures": ["Array.skins[query.variant]"],
                },
                "controller.render.soccer_keeper": {
                    "arrays": {"textures": {"Array.skins": [f"Texture.v{i}" for i in range(len(TEAMS))]}},
                    "geometry": "Geometry.default",
                    "materials": [{"*": "Material.default"}],
                    "textures": ["Array.skins[query.variant]"],
                },
            },
        },
    )
    common = {
        "materials": {"default": "entity_alphatest"},
        "geometry": {"default": "geometry.soccer_player"},
        "animations": {"walk": "animation.soccer_player.walk", "look": "animation.soccer_player.look"},
        "scripts": {"animate": ["walk", "look"]},
    }
    for ident, textures, controller in [
        ("soccer:player", field_tex, "controller.render.soccer_player"),
        ("soccer:keeper", keeper_tex, "controller.render.soccer_keeper"),
    ]:
        desc = dict(common, identifier=ident, textures=textures, render_controllers=[controller])
        name = ident.split(":")[1]
        write_json(
            os.path.join(RP, "entity", f"{name}.entity.json"),
            {"format_version": "1.10.0", "minecraft:client_entity": {"description": desc}},
        )


# ===== 操作アイテム（使うと発動） =====
# (id, テクスチャ名, 日本語名, 英語名, 矢印の色, 矢印の形)
ACTION_ITEMS = [
    ("soccer:pass", "soccer_pass", "パス（使う＝パス）", "Pass (Use)", (60, 200, 80, 255), "straight"),
    ("soccer:cross", "soccer_cross", "クロス／ロブ（使う＝浮き球）", "Cross / Lob (Use)", (240, 190, 40, 255), "arc"),
    ("soccer:through", "soccer_through", "スルーパス（使う＝スルーパス）", "Through Ball (Use)", (60, 140, 240, 255), "double"),
]
# 手で描いた（build.py で作らない）アイテム
STATIC_ITEMS = [
    ("soccer:boots", "soccer_boots", "サッカーシューズ（使う＝シュート）", "Soccer Boots (Use = Shoot)"),
    ("soccer:whistle", "soccer_whistle", "ホイッスル（使う＝試合メニュー）", "Whistle (Use = Match Menu)"),
]


def make_action_icon(color, shape):
    """左下にボール、右上へ向かう矢印のアイコン（16x16）"""
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    ball = ["..WWWW..", ".WWKKWW.", "WWKKKKWW", "WWWKKWWW", "WKWWWWKW", "WWWWWWWW", ".WWWWWW.", "..WWWW.."]
    for y, row in enumerate(ball):
        for x, c in enumerate(row):
            if c != ".":
                img.putpixel((x, 8 + y), WHITE if c == "W" else BLACK)
    pts = []
    if shape == "straight":
        pts = [(9 + i, 6) for i in range(6)] + [(13, 4), (13, 5), (14, 5), (13, 7), (13, 8), (14, 7)]
    elif shape == "arc":
        pts = [(8, 7), (8, 6), (9, 5), (9, 4), (10, 3), (11, 3), (12, 3), (13, 4), (13, 5), (14, 6), (14, 7)]
        pts += [(12, 6), (13, 7), (15, 6), (15, 5)]
    elif shape == "double":
        for y in (3, 7):
            pts += [(9 + i, y) for i in range(5)] + [(13, y - 1), (14, y), (13, y + 1)]
    for x, y in pts:
        if 0 <= x < 16 and 0 <= y < 16:
            img.putpixel((x, y), color)
    return img


def build_items():
    items_dir = os.path.join(BP, "items")
    tex_dir = os.path.join(RP, "textures", "items")
    os.makedirs(tex_dir, exist_ok=True)
    texture_data = {}
    for ident, tex, *_ in STATIC_ITEMS:
        texture_data[tex] = {"textures": f"textures/items/{tex}"}
    for ident, tex, _ja, _en, color, shape in ACTION_ITEMS:
        make_action_icon(color, shape).save(os.path.join(tex_dir, f"{tex}.png"))
        texture_data[tex] = {"textures": f"textures/items/{tex}"}
        write_json(
            os.path.join(items_dir, f"{tex}.json"),
            {
                "format_version": "1.20.80",
                "minecraft:item": {
                    "description": {"identifier": ident, "menu_category": {"category": "equipment"}},
                    "components": {"minecraft:icon": {"texture": tex}, "minecraft:max_stack_size": 1},
                },
            },
        )
    write_json(
        os.path.join(RP, "textures", "item_texture.json"),
        {"resource_pack_name": "soccer", "texture_name": "atlas.items", "texture_data": texture_data},
    )

    # 名前（.lang）の item 行を作り直す
    for lang, col in (("ja_JP", 2), ("en_US", 3)):
        path = os.path.join(RP, "texts", f"{lang}.lang")
        with open(path, encoding="utf-8") as f:
            lines = [l for l in f.read().splitlines() if l and not l.startswith("item.soccer:")]
        for item in STATIC_ITEMS + [a[:4] for a in ACTION_ITEMS]:
            lines.append(f"item.{item[0]}.name={item[col]}")
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")


def build_teams_js():
    """スクリプトが使うチームの一覧を書き出す"""
    teams = []
    for t, team in enumerate(TEAMS):
        teams.append(
            {
                "key": team["key"],
                "name": team["name"],
                "fieldVariantBase": t * 10,
                "keeperVariant": t,
                "players": [{"num": p[0], "name": p[1]} for p in team["players"]],
                "keeper": {"num": team["keeper"][0], "name": team["keeper"][1]},
            }
        )
    body = json.dumps(teams, ensure_ascii=False, indent=2)
    with open(os.path.join(BP, "scripts", "teams.js"), "w", encoding="utf-8") as f:
        f.write("// このファイルは tools/build.py が自動で作る。国や選手を変えるときは build.py を編集する\n")
        f.write(f"export const TEAMS = {body};\n")


def build_manifests():
    v = VERSION
    vs = ".".join(map(str, v))
    for path, kind in [(os.path.join(BP, "manifest.json"), "ビヘイビア"), (os.path.join(RP, "manifest.json"), "リソース")]:
        with open(path, encoding="utf-8") as f:
            m = json.load(f)
        m["header"]["name"] = f"サッカー v{vs} {kind}"
        m["header"]["version"] = v
        for mod in m["modules"]:
            mod["version"] = v
        for dep in m.get("dependencies", []):
            if "uuid" in dep:
                dep["version"] = v
        write_json(path, m)


def build_mcaddon():
    vs = ".".join(map(str, VERSION))
    for name in os.listdir(ROOT):
        if name.endswith(".mcaddon"):
            os.remove(os.path.join(ROOT, name))
    out = os.path.join(ROOT, f"SoccerAddon_v{vs}.mcaddon")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for pack in (BP, RP):
            for dirpath, _dirs, files in os.walk(pack):
                for fn in sorted(files):
                    full = os.path.join(dirpath, fn)
                    z.write(full, os.path.relpath(full, ROOT))
    return out


if __name__ == "__main__":
    build_textures()
    build_entities()
    build_items()
    build_teams_js()
    build_manifests()
    print(build_mcaddon())
