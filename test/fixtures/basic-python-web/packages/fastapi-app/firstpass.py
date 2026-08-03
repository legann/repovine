from fastapi import APIRouter, FastAPI

app = FastAPI()
PREFIX: str = "/pos"

pos_router = APIRouter(PREFIX)


@pos_router.get("/info")
def info():
    return {}


def report():
    return {}


app.add_api_route("/report", report, methods=["GET", "POST"])


@app.websocket("/ws/feed")
async def ws_feed():
    pass
