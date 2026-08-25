"""Consistent JSON error envelope: every failure returns {"error": "<message>"}."""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .logging import get_logger

log = get_logger("api")


class ApiError(Exception):
    """Raise to return a specific status + message in the {error} envelope."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_req: Request, exc: ApiError):
        return JSONResponse(status_code=exc.status_code, content={"error": exc.message})

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_req: Request, exc: StarletteHTTPException):
        detail = exc.detail
        message = detail if isinstance(detail, str) else "HTTP error"
        return JSONResponse(status_code=exc.status_code, content={"error": message})

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_req: Request, exc: RequestValidationError):
        # Surface the first validation problem in the same {error} shape.
        errs = exc.errors()
        msg = "Invalid request"
        if errs:
            loc = ".".join(str(p) for p in errs[0].get("loc", []) if p != "body")
            msg = f"{loc}: {errs[0].get('msg')}" if loc else str(errs[0].get("msg"))
        return JSONResponse(status_code=422, content={"error": msg})

    @app.exception_handler(Exception)
    async def _unhandled(_req: Request, exc: Exception):
        log.exception("unhandled error: %s", exc)
        return JSONResponse(status_code=500, content={"error": str(exc) or "Internal error"})
