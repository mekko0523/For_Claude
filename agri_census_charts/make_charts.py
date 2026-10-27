"""農林業センサスの作付面積（棒）と1経営体当たり平均作付面積（線）の複合グラフを作物ごとにPNG出力する。

使い方: python3 make_charts.py [census_data.csv]
"""
import csv
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

HERE = Path(__file__).parent
YEARS = [2005, 2010, 2015, 2020, 2025]
BAR_COLOR = {"水稲": "#7FA65A", "大豆": "#C9A227"}
LINE_COLOR = "#2B4C7E"
INK, MUTED, GRID = "#1F2328", "#5B6470", "#E3E6EA"


def set_japanese_font():
    for name in ("IPAGothic", "IPAexGothic", "Noto Sans CJK JP", "WenQuanYi Zen Hei"):
        if any(f.name == name for f in font_manager.fontManager.ttflist):
            plt.rcParams["font.family"] = name
            return
    sys.exit("日本語フォントが見つかりません（IPAGothic など）")


def load(path):
    rows = {}
    with open(path, encoding="utf-8") as f:
        lines = [line for line in f if not line.startswith("#")]
    for r in csv.DictReader(lines):
        if not r["area_ha"] or not r["entities"]:
            sys.exit(f"未入力の値があります: {r['crop']} {r['year']}")
        rows.setdefault(r["crop"], {})[int(r["year"])] = (float(r["area_ha"]), float(r["entities"]))
    return rows


def plot(crop, data, out):
    area = [data[y][0] / 1000 for y in YEARS]  # 千ha
    avg = [data[y][0] / data[y][1] for y in YEARS]
    x = range(len(YEARS))

    fig, ax = plt.subplots(figsize=(9, 5.4), dpi=200)
    ax2 = ax.twinx()

    bars = ax.bar(x, area, width=0.55, color=BAR_COLOR[crop], label="作付面積（千ha・左軸）", zorder=2)
    ax.bar_label(bars, labels=[f"{v:,.1f}" for v in area], padding=3, fontsize=9, color=MUTED)
    ax2.plot(x, avg, color=LINE_COLOR, linewidth=2.2, marker="o", markersize=7,
             markeredgecolor="white", markeredgewidth=1.5, label="1経営体当たり平均作付面積（ha/経営体・右軸）", zorder=3)
    for i, v in enumerate(avg):
        ax2.annotate(f"{v:.2f}", (i, v), textcoords="offset points", xytext=(0, 10),
                     ha="center", fontsize=10, color=INK, fontweight="bold")

    ax.set_xticks(list(x), [f"{y}年" for y in YEARS])
    ax.set_ylabel("作付面積（千ha）", color=INK)
    ax2.set_ylabel("平均作付面積（ha／経営体）", color=INK)
    ax.set_ylim(0, max(area) * 1.18)
    ax2.set_ylim(0, max(avg) * 1.25)
    ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{v:,.0f}"))
    ax.grid(axis="y", color=GRID, linewidth=0.8, zorder=0)
    for a in (ax, ax2):
        a.tick_params(colors=MUTED, length=0)
        for s in a.spines.values():
            s.set_visible(False)
    ax.spines["bottom"].set_visible(True)
    ax.spines["bottom"].set_color("#B8BEC6")

    ax.set_title(f"{crop}：作付面積と1経営体当たり平均作付面積の推移（全国）",
                 loc="left", fontsize=14, color=INK, fontweight="bold", pad=28)
    h1, l1 = ax.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax.legend(h1 + h2, l1 + l2, loc="lower left", bbox_to_anchor=(0, 1.0), ncol=2, frameon=False,
              fontsize=9, labelcolor=INK, borderaxespad=0.2)
    fig.text(0.01, 0.01, "資料：農林水産省「農林業センサス」（農業経営体、販売目的の作付）。平均作付面積＝作付面積÷作付経営体数。",
             fontsize=8, color=MUTED)
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(out, facecolor="white")
    plt.close(fig)


def main():
    set_japanese_font()
    data = load(sys.argv[1] if len(sys.argv) > 1 else HERE / "census_data.csv")
    for crop in ("水稲", "大豆"):
        out = HERE / f"chart_{'suito' if crop == '水稲' else 'daizu'}.png"
        plot(crop, data[crop], out)
        print("wrote", out)


if __name__ == "__main__":
    main()
