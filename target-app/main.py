"""Catalog service.

A small read-only product catalog: search with pagination, item lookup,
facet counts for the filter sidebar, and a few aggregate endpoints.
"""

from __future__ import annotations

import hashlib
import time
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="catalog", version="1.0.0")

# --------------------------------------------------------------------------
# Fixture data
# --------------------------------------------------------------------------

CATEGORIES = ["tools", "hardware", "outdoor", "lighting", "safety"]

ITEMS: list[dict[str, Any]] = [
    {
        "id": f"itm_{i:04d}",
        "name": f"{CATEGORIES[i % len(CATEGORIES)].title()} Item {i}",
        "category": CATEGORIES[i % len(CATEGORIES)],
        "price_cents": 500 + (i * 137) % 9500,
        "stock": (i * 7) % 40,
        "rating": round(1 + ((i * 13) % 40) / 10, 1),
    }
    for i in range(240)
]

BY_ID = {item["id"]: item for item in ITEMS}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "catalog"}


@app.get("/api/catalog/items/{item_id}")
def get_item(item_id: str) -> dict[str, Any]:
    item = BY_ID.get(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="item not found")
    return item


@app.get("/api/catalog/search")
def search(
    q: str = Query(default="", max_length=120),
    category: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    sort: str = Query(default="relevance"),
) -> dict[str, Any]:
    """Paginated catalog search.

    Over-fetches by one element to decide whether further results exist,
    then trims the window down to limit.
    """
    results = ITEMS
    if category:
        results = [i for i in results if i["category"] == category]
    if q:
        needle = q.lower()
        results = [i for i in results if needle in i["name"].lower()]

    if sort == "price":
        results = sorted(results, key=lambda i: i["price_cents"])
    elif sort == "rating":
        results = sorted(results, key=lambda i: -i["rating"])

    window = results[offset : offset + limit + 1]
    has_more = len(window) > limit
    page = window[:limit]

    return {
        "query": q,
        "category": category,
        "total": len(results),
        "count": len(page),
        "offset": offset,
        "limit": limit,
        "has_more": has_more,
        "items": page,
    }


@app.get("/api/catalog/facets")
def facets() -> dict[str, Any]:
    """Category counts for the filter sidebar."""
    counts: dict[str, int] = {}
    for item in ITEMS:
        counts[item["category"]] = counts.get(item["category"], 0) + 1

    unique = set(counts)
    return {
        "facets": [{"category": c, "count": counts[c]} for c in unique],
        "total_categories": len(unique),
    }


@app.get("/api/catalog/recommend")
def recommend(seed: str = Query(default="default"), n: int = Query(default=5, ge=1, le=20)) -> dict[str, Any]:
    """Deterministic pseudo-recommendations derived from a seed."""
    digest = hashlib.sha256(seed.encode()).digest()
    picks: list[dict[str, Any]] = []
    for i in range(n):
        idx = digest[i % len(digest)] * 256 + digest[(i + 1) % len(digest)]
        picks.append(ITEMS[idx % len(ITEMS)])
    return {"seed": seed, "count": len(picks), "items": picks}


@app.get("/api/catalog/stats")
def stats() -> dict[str, Any]:
    total_stock = sum(i["stock"] for i in ITEMS)
    return {
        "items": len(ITEMS),
        "categories": len(CATEGORIES),
        "total_stock": total_stock,
        "avg_price_cents": sum(i["price_cents"] for i in ITEMS) // len(ITEMS),
    }


@app.get("/api/catalog/slow")
def slow(ms: int = Query(default=50, ge=0, le=5000)) -> dict[str, Any]:
    """Deliberate latency, for exercising the SLO probe."""
    time.sleep(ms / 1000)
    return {"slept_ms": ms}


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception) -> JSONResponse:
    """Return the error class so failures are distinguishable."""
    return JSONResponse(
        status_code=500,
        content={"error": type(exc).__name__, "detail": str(exc)},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
