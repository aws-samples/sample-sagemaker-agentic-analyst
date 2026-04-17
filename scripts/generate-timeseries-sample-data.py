#!/usr/bin/env python3
"""
sample-data の時系列データを 2 年分（2023-04-17 〜 2025-04-16、730日）まで拡充する。

各テーブルの日次粒度を保ちつつ、週次周期性（週末↑）・年次季節性（12月ピーク）・緩やかなトレンドを含める。
Chronos-2 がトレンド/季節性を学習できる規模にする。
"""
from __future__ import annotations
import csv
import math
import random
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'apps' / 'cdk' / 'sample-data' / 'raw' / 'sales'

START = date(2023, 4, 17)
END = date(2025, 4, 16)  # 730日
DAYS = (END - START).days + 1

random.seed(42)


def seasonal(d: date, amplitude_year: float, amplitude_week: float) -> float:
    """年次 + 週次の季節性係数（0 基準）"""
    doy = d.timetuple().tm_yday
    year_wave = amplitude_year * math.sin(2 * math.pi * (doy - 80) / 365.25)  # 春→夏↑、冬↓
    # 12月のピーク（年末商戦）
    if d.month == 12:
        year_wave += amplitude_year * 0.6
    # 週次: 金土日↑
    week_wave = amplitude_week * (1 if d.weekday() in (4, 5, 6) else 0)
    return year_wave + week_wave


def trend(i: int, total: int, slope: float) -> float:
    """緩やかな線形トレンド（-1.0 から +1.0 に正規化して掛ける）"""
    return slope * (i / total)


# --- retail_sales_performance ---
STORE_PRODUCTS = [
    ('S001', 'P101', 15000, 0.15),  # 基準値, 年次振幅率
    ('S002', 'P102', 9000, 0.20),
    ('S003', 'P103', 12000, 0.18),
    ('S004', 'P101', 9800, 0.12),
    ('S005', 'P104', 11500, 0.22),
]


def gen_retail() -> None:
    out = ROOT / 'retail_sales_performance' / 'retail_sales_performance.csv'
    with out.open('w', newline='') as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(['date', 'store_id', 'product_id', 'sales_amount', 'units_sold'])
        for i in range(DAYS):
            d = START + timedelta(days=i)
            for store, product, base, amp in STORE_PRODUCTS:
                s = seasonal(d, amp, 0.08)
                t = trend(i, DAYS, 0.25)  # 2年で +25%
                noise = random.gauss(0, 0.04)
                sales = base * (1 + s + t + noise)
                units = int(sales / 125 * (1 + random.gauss(0, 0.03)))
                w.writerow([d.isoformat(), store, product, f'{sales:.2f}', max(1, units)])


# --- sales_rep_performance ---
REPS = [
    ('REP001', 45000, 0.10),
    ('REP002', 35000, 0.18),
    ('REP003', 55000, 0.12),
]


def gen_rep() -> None:
    out = ROOT / 'sales_rep_performance' / 'sales_rep_performance.csv'
    with out.open('w', newline='') as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(['date', 'sales_rep_id', 'total_sales_amount', 'deals_closed', 'customer_satisfaction_score'])
        for i in range(DAYS):
            d = START + timedelta(days=i)
            if d.weekday() in (5, 6):  # 週末は営業活動なし
                continue
            for rep, base, amp in REPS:
                s = seasonal(d, amp, 0.0)
                t = trend(i, DAYS, 0.15)
                noise = random.gauss(0, 0.08)
                sales = base * (1 + s + t + noise)
                deals = max(1, int(round(sales / 10000 + random.gauss(0, 0.5))))
                score = min(5.0, max(3.5, 4.5 + random.gauss(0, 0.15)))
                w.writerow([d.isoformat(), rep, f'{sales:.2f}', deals, f'{score:.1f}'])


# --- b2b_sales_pipeline ---
STAGES = ['Discovery', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost']


def gen_b2b() -> None:
    out = ROOT / 'b2b_sales_pipeline' / 'b2b_sales_pipeline.csv'
    with out.open('w', newline='') as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(['date', 'sales_rep_id', 'customer_id', 'deal_value', 'pipeline_stage'])
        cust = 1
        for i in range(DAYS):
            d = START + timedelta(days=i)
            if d.weekday() in (5, 6):
                continue
            # 1日あたり2〜5件のディール
            n_deals = random.randint(2, 5)
            s = seasonal(d, 0.20, 0.0)
            t = trend(i, DAYS, 0.30)
            for _ in range(n_deals):
                rep = random.choice([r[0] for r in REPS])
                base = random.uniform(50000, 300000)
                deal = base * (1 + s + t + random.gauss(0, 0.1))
                stage = random.choice(STAGES)
                w.writerow([d.isoformat(), rep, f'B2B{cust:04d}', f'{deal:.2f}', stage])
                cust += 1


# --- ecommerce_customer_behavior ---
PRODUCTS = [('P101', 89.99), ('P102', 149.50), ('P103', 45.00), ('P104', 299.00)]


def gen_ecom() -> None:
    out = ROOT / 'ecommerce_customer_behavior' / 'ecommerce_customer_behavior.csv'
    with out.open('w', newline='') as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(['date', 'customer_id', 'product_id', 'page_views', 'purchase_amount'])
        cust_id = 1000
        for i in range(DAYS):
            d = START + timedelta(days=i)
            s = seasonal(d, 0.25, 0.15)
            t = trend(i, DAYS, 0.40)
            n_events = max(4, int(8 * (1 + s + t + random.gauss(0, 0.1))))
            for _ in range(n_events):
                cust_id += 1
                # customer_id はラウンドロビン
                cid = f'C{(cust_id % 6) + 1001}'
                prod, price = random.choice(PRODUCTS)
                views = max(1, int(random.gauss(10, 4)))
                # 購入率はトレンドに連動
                purchase_rate = 0.5 + 0.2 * (s + t)
                amount = price if random.random() < purchase_rate else 0.0
                w.writerow([d.isoformat(), cid, prod, views, f'{amount:.2f}'])


if __name__ == '__main__':
    gen_retail()
    gen_rep()
    gen_b2b()
    gen_ecom()
    print(f'Generated {DAYS} days: {START} .. {END}')
