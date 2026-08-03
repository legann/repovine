"""Scenario 3 of §2: the Python plugin learns a framework. Both aiohttp route forms appear."""
from aiohttp import web

routes = web.RouteTableDef()


@routes.get('/healthz')
async def healthz(request):
    return web.json_response({'ok': True})


@routes.post('/orders')
async def create_order(request):
    payload = await request.json()
    return web.json_response({'id': payload['id']}, status=201)


async def metrics(request):
    return web.Response(text='requests 1')


def create_app():
    app = web.Application()
    app.add_routes(routes)
    # The imperative form, inside the factory where aiohttp projects put it.
    app.router.add_get('/metrics', metrics)
    app.router.add_route('DELETE', '/orders/{order_id}', create_order)
    return app
