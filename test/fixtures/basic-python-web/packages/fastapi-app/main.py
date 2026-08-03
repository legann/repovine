from fastapi import APIRouter, FastAPI

app = FastAPI()
router = APIRouter(prefix="/api")


@app.get("/health")
def health():
    return {"ok": True}


@router.post("/items")
def create_item():
    return {}


v1_router = APIRouter()


@v1_router.get("/users")
def list_users_v1():
    return []


METRICS_PREFIX = "/metrics"
API_VER = "3"

metrics_router = APIRouter()


@metrics_router.get("/live")
def liveness():
    return {"ok": True}


v3_router = APIRouter()


@v3_router.get("/status")
def status_v3():
    return {}


app.include_router(router)
app.include_router(v1_router, prefix="/v1")
app.include_router(metrics_router, prefix=METRICS_PREFIX)
app.include_router(v3_router, prefix=f"/v{API_VER}")
