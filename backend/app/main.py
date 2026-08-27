"""FastAPI app factory for DecisionGuru — serves the same /api contract as the retired
Node/Express backend so the existing frontend works with zero changes."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .core.config import settings
from .core.db import init_db
from .core.errors import install_error_handlers
from .core.logging import setup_logging
from .core.timefmt import iso_now


def create_app() -> FastAPI:
    setup_logging()
    init_db()

    # Repair any legacy minor-unit (GBp) cache rows written before normalisation,
    # so headline figures are correct on first load without a live refresh.
    try:
        from .services.marketdata import repair_minor_units

        repair_minor_units()
    except Exception:  # noqa: BLE001 — never block startup on a cache repair
        pass

    # Reconcile persisted resolution (symbol_map/instruments) with the curated
    # ISIN seed and purge the orphaned symbols' caches, so a corrected share-class
    # mapping takes effect without a manual DB edit (e.g. Swatch UHR.SW->UHRN.SW).
    try:
        from .services.marketdata import repair_misresolved_instruments

        repair_misresolved_instruments()
    except Exception:  # noqa: BLE001 — never block startup on a cache repair
        pass

    app = FastAPI(
        title="DecisionGuru API",
        version="0.1.0",
        description="Swiss tax-aware investment counterfactual analyzer — FastAPI backend.",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    install_error_handlers(app)

    @app.get("/api/health")
    async def health() -> dict:
        return {"ok": True, "service": "decisionguru", "time": iso_now()}

    # Routers (mounted under /api to match the frontend contract).
    from .routers import (
        analysis,
        data,
        decisions,
        export,
        imports,
        instruments,
        marketdata,
        notes,
        plans,
        research,
        scenarios,
        settings as settings_router,
        transactions,
        watchlist,
    )

    app.include_router(instruments.router, prefix="/api/instruments", tags=["instruments"])
    app.include_router(transactions.router, prefix="/api/transactions", tags=["transactions"])
    app.include_router(imports.router, prefix="/api/imports", tags=["imports"])
    app.include_router(marketdata.router, prefix="/api/market", tags=["market"])
    app.include_router(analysis.router, prefix="/api/analysis", tags=["analysis"])
    app.include_router(decisions.router, prefix="/api/decisions", tags=["decisions"])
    app.include_router(plans.router, prefix="/api/plans", tags=["plans"])
    app.include_router(research.router, prefix="/api/research", tags=["research"])
    app.include_router(scenarios.router, prefix="/api/scenarios", tags=["scenarios"])
    app.include_router(settings_router.router, prefix="/api/settings", tags=["settings"])
    app.include_router(notes.router, prefix="/api/notes", tags=["notes"])
    app.include_router(export.router, prefix="/api/export", tags=["export"])
    app.include_router(data.router, prefix="/api/data", tags=["data"])
    app.include_router(watchlist.router, prefix="/api/watchlist", tags=["watchlist"])

    return app


app = create_app()


def main() -> None:
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    main()
