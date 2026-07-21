# Stdlib ast extractor for repovine Python web framework routes.
# Invoked as: python3 -c "$(cat route-ast-script.py)"  (file paths on stdin)
import ast
import json
import sys

FASTAPI_METHODS = frozenset({"get", "post", "put", "delete", "patch", "head", "options", "trace"})
FASTAPI_WEBSOCKET = "websocket"
DRF_ROUTER_CLASSES = frozenset({"DefaultRouter", "SimpleRouter", "ExtendedDefaultRouter"})

# Server-rendered template support: literal template names rendered by a view body.
TEMPLATE_EXTENSIONS = (".html", ".htm", ".jinja", ".jinja2", ".j2", ".xml", ".txt")
DJANGO_TEMPLATE_VIEW_FUNCS = frozenset({"render", "render_to_string"})


def is_dunder(name):
    return name.startswith("__") and name.endswith("__")


def env_name_from(node):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        f = node.func
        if f.attr == "getenv" and isinstance(f.value, ast.Name) and f.value.id == "os":
            pass
        elif (
            f.attr == "get"
            and isinstance(f.value, ast.Attribute)
            and f.value.attr == "environ"
            and isinstance(f.value.value, ast.Name)
            and f.value.value.id == "os"
        ):
            pass
        else:
            return None
        if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
            return node.args[0].value
        return None
    if isinstance(node, ast.Subscript):
        v = node.value
        if (
            isinstance(v, ast.Attribute)
            and v.attr == "environ"
            and isinstance(v.value, ast.Name)
            and v.value.id == "os"
        ):
            s = node.slice
            if s.__class__.__name__ == "Index":
                s = s.value
            if isinstance(s, ast.Constant) and isinstance(s.value, str):
                return s.value
    return None


def literal_str(node, constants):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts = []
        for v in node.values:
            if isinstance(v, ast.Constant) and isinstance(v.value, str):
                parts.append(v.value)
            elif isinstance(v, ast.FormattedValue):
                if isinstance(v.value, ast.Name) and v.value.id in constants:
                    parts.append(constants[v.value.id])
                elif isinstance(v.value, ast.Constant) and isinstance(v.value.value, str):
                    parts.append(v.value.value)
                else:
                    return None
            else:
                return None
        return "".join(parts)
    if isinstance(node, ast.Name) and node.id in constants:
        return constants[node.id]
    return None


def join_paths(prefix, path):
    if not prefix:
        result = path if path.startswith("/") else "/" + path
    else:
        base = prefix.rstrip("/")
        tail = path if path.startswith("/") else "/" + path
        result = base + tail
    if not result.startswith("/"):
        result = "/" + result
    return result


def collect_string_constants(tree):
    constants = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    s = literal_str(node.value, constants)
                    if s is not None:
                        constants[t.id] = s
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name) and node.value is not None:
                s = literal_str(node.value, constants)
                if s is not None:
                    constants[node.target.id] = s
    return constants


def collect_custom_router_classes(tree):
    custom = set()
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        for base in node.bases:
            if isinstance(base, ast.Name) and base.id in DRF_ROUTER_CLASSES:
                custom.add(node.name)
    return custom


def detect_framework(imports):
    framework = None
    for imp in imports:
        module = imp.get("module") or ""
        kind = imp.get("kind")
        names = imp.get("names") or []
        if kind == "from" and module == "fastapi":
            for n in names:
                if n in ("FastAPI", "APIRouter") or n.split(".")[-1] in ("FastAPI", "APIRouter"):
                    framework = "fastapi"
        if kind == "from" and module == "rest_framework.routers":
            for n in names:
                if n in DRF_ROUTER_CLASSES:
                    framework = "drf"
        if kind == "from" and module == "rest_framework.decorators":
            for n in names:
                if n in ("action", "api_view"):
                    framework = "drf"
        if kind == "from" and module == "django.urls":
            for n in names:
                if n in ("path", "re_path", "include"):
                    if framework != "drf":
                        framework = "django"
        if kind == "import" and module.split(".")[0] == "django":
            if framework != "drf":
                framework = "django"
        if kind == "from" and module == "flask":
            for n in names:
                if n in ("Flask", "Blueprint") and framework is None:
                    framework = "flask"
        if kind == "import" and module.split(".")[0] == "flask" and framework is None:
            framework = "flask"
    return framework


def fastapi_route_from_decorator(dec, constants):
    if not isinstance(dec, ast.Call):
        return None
    func = dec.func
    if not isinstance(func, ast.Attribute) or func.attr not in FASTAPI_METHODS:
        return None
    if not dec.args:
        return None
    path = literal_str(dec.args[0], constants)
    if path is None:
        return None
    receiver = func.value.id if isinstance(func.value, ast.Name) else None
    return {"path": path, "method": func.attr.upper(), "receiver": receiver, "line": dec.lineno}


def fastapi_websocket_from_decorator(dec, constants):
    if not isinstance(dec, ast.Call):
        return None
    func = dec.func
    if not isinstance(func, ast.Attribute) or func.attr != FASTAPI_WEBSOCKET:
        return None
    if not dec.args:
        return None
    path = literal_str(dec.args[0], constants)
    if path is None:
        return None
    receiver = func.value.id if isinstance(func.value, ast.Name) else None
    return {"path": path, "method": "WEBSOCKET", "receiver": receiver, "line": dec.lineno}


def parse_http_methods_list(node, constants):
    if not isinstance(node, (ast.List, ast.Tuple)):
        return None
    parsed = []
    for el in node.elts:
        m = literal_str(el, constants)
        if m is None and isinstance(el, ast.Constant) and isinstance(el.value, str):
            m = el.value
        if m is not None:
            parsed.append(m.upper())
    return parsed if parsed else None


def fastapi_add_api_routes(call, constants):
    if not isinstance(call, ast.Call):
        return None
    func = call.func
    if not isinstance(func, ast.Attribute) or func.attr != "add_api_route":
        return None
    if not call.args:
        return None
    path = literal_str(call.args[0], constants)
    if path is None:
        return None
    component = "(handler)"
    if len(call.args) >= 2:
        arg1 = call.args[1]
        if isinstance(arg1, ast.Name):
            component = arg1.id
        elif isinstance(arg1, ast.Attribute) and isinstance(arg1.value, ast.Name):
            component = arg1.value.id + "." + arg1.attr
    methods = ["GET"]
    for kw in call.keywords:
        if kw.arg == "methods":
            parsed = parse_http_methods_list(kw.value, constants)
            if parsed:
                methods = parsed
    receiver = func.value.id if isinstance(func.value, ast.Name) else None
    return [
        {"path": path, "method": m, "component": component, "receiver": receiver, "line": call.lineno}
        for m in methods
    ]


def drf_api_view_info(dec, constants):
    if not isinstance(dec, ast.Call):
        return None
    func = dec.func
    name = func.id if isinstance(func, ast.Name) else (func.attr if isinstance(func, ast.Attribute) else None)
    if name != "api_view":
        return None
    methods = None
    if dec.args:
        methods = parse_http_methods_list(dec.args[0], constants)
    for kw in dec.keywords:
        if kw.arg == "methods":
            methods = parse_http_methods_list(kw.value, constants)
    if not methods:
        methods = ["GET"]
    return {"methods": methods, "line": dec.lineno}


def collect_api_view_methods(tree, constants):
    out = {}
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            info = drf_api_view_info(dec, constants)
            if info is not None:
                out[node.name] = info["methods"]
    return out


def django_path_from_call(call, constants):
    if not isinstance(call, ast.Call):
        return None
    func = call.func
    name = func.id if isinstance(func, ast.Name) else (func.attr if isinstance(func, ast.Attribute) else None)
    if name not in ("path", "re_path"):
        return None
    if not call.args:
        return None
    path = literal_str(call.args[0], constants)
    if path is None:
        return None
    view = None
    if len(call.args) >= 2 and isinstance(call.args[1], ast.Name):
        view = call.args[1].id
    return {"path": path, "method": "GET", "view": view, "line": call.lineno, "is_regex": name == "re_path"}


def include_router_extra_prefix(call, constants):
    if not isinstance(call, ast.Call):
        return None
    func = call.func
    if not isinstance(func, ast.Attribute) or func.attr != "include_router":
        return None
    if not call.args or not isinstance(call.args[0], ast.Name):
        return None
    router_var = call.args[0].id
    extra = ""
    for kw in call.keywords:
        if kw.arg == "prefix":
            p = literal_str(kw.value, constants)
            if p is not None:
                extra = p
    return (router_var, extra)


def drf_router_kind_from_call(call, custom_router_classes):
    if not isinstance(call, ast.Call):
        return None
    func = call.func
    name = func.id if isinstance(func, ast.Name) else (func.attr if isinstance(func, ast.Attribute) else None)
    if name in DRF_ROUTER_CLASSES:
        return name
    if name in custom_router_classes:
        return "DefaultRouter"
    return None


def is_drf_router_call(call, custom_router_classes):
    return drf_router_kind_from_call(call, custom_router_classes) is not None


def drf_register_info(call, constants):
    if not isinstance(call, ast.Call):
        return None
    func = call.func
    if not isinstance(func, ast.Attribute) or func.attr != "register":
        return None
    if not isinstance(func.value, ast.Name):
        return None
    prefix = None
    viewset = None
    if call.args:
        p = literal_str(call.args[0], constants)
        if p is not None:
            prefix = p
        if len(call.args) >= 2 and isinstance(call.args[1], ast.Name):
            viewset = call.args[1].id
    for kw in call.keywords:
        if kw.arg == "prefix":
            p = literal_str(kw.value, constants)
            if p is not None:
                prefix = p
        if kw.arg == "viewset" and isinstance(kw.value, ast.Name):
            viewset = kw.value.id
    if prefix is None:
        return None
    return {"router": func.value.id, "prefix": prefix, "viewset": viewset or "(viewset)", "line": call.lineno}


def drf_routes_from_register(prefix, viewset, line, router_kind):
    p = prefix.strip("/")
    base = "/" + p + "/"
    detail = "/" + p + "/{pk}/"
    out = []
    if router_kind == "SimpleRouter":
        pairs = (("GET", base), ("GET", detail))
    else:
        pairs = (
            ("GET", base),
            ("POST", base),
            ("GET", detail),
            ("PUT", detail),
            ("PATCH", detail),
            ("DELETE", detail),
        )
    for method, path in pairs:
        out.append({"path": path, "method": method, "component": viewset, "line": line})
    return out


def django_path_include_router_urls(call, constants):
    if not isinstance(call, ast.Call):
        return None
    func = call.func
    name = func.id if isinstance(func, ast.Name) else (func.attr if isinstance(func, ast.Attribute) else None)
    if name != "path" or len(call.args) < 2:
        return None
    mount = literal_str(call.args[0], constants)
    if mount is None:
        return None
    inc = call.args[1]
    if not isinstance(inc, ast.Call):
        return None
    inc_func = inc.func
    inc_name = inc_func.id if isinstance(inc_func, ast.Name) else (inc_func.attr if isinstance(inc_func, ast.Attribute) else None)
    if inc_name != "include" or not inc.args:
        return None
    arg0 = inc.args[0]
    if isinstance(arg0, ast.Tuple) and arg0.elts:
        arg0 = arg0.elts[0]
    if isinstance(arg0, ast.Attribute) and arg0.attr == "urls" and isinstance(arg0.value, ast.Name):
        return (mount, arg0.value.id, "router")
    if isinstance(arg0, ast.Name):
        return (mount, arg0.id, "patterns")
    return None


def drf_action_info(dec, constants):
    if not isinstance(dec, ast.Call):
        return None
    func = dec.func
    name = func.id if isinstance(func, ast.Name) else (func.attr if isinstance(func, ast.Attribute) else None)
    if name != "action":
        return None
    detail = False
    url_path = None
    methods = ["GET"]
    for kw in dec.keywords:
        if kw.arg == "detail" and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, bool):
            detail = kw.value.value
        if kw.arg == "url_path":
            url_path = literal_str(kw.value, constants)
        if kw.arg == "methods" and isinstance(kw.value, (ast.List, ast.Tuple)):
            parsed = []
            for el in kw.value.elts:
                m = literal_str(el, constants)
                if m is None and isinstance(el, ast.Constant) and isinstance(el.value, str):
                    m = el.value
                if m is not None:
                    parsed.append(m.upper())
            if parsed:
                methods = parsed
    return {"detail": detail, "url_path": url_path, "methods": methods, "line": dec.lineno}


def drf_action_paths(mount, register_prefix, detail, url_path, method_name):
    root = join_paths(mount, "/" + register_prefix.strip("/") + "/")
    segment = (url_path or method_name).strip("/")
    if detail:
        return root.rstrip("/") + "/{pk}/" + segment + "/"
    return join_paths(root, segment + "/")


def router_prefix_from_call(call, constants):
    if not isinstance(call, ast.Call):
        return None
    func = call.func
    name = func.id if isinstance(func, ast.Name) else (func.attr if isinstance(func, ast.Attribute) else None)
    if name == "Blueprint":
        # Flask: Blueprint('name', __name__, url_prefix='/admin').
        for kw in call.keywords:
            if kw.arg == "url_prefix":
                return literal_str(kw.value, constants)
        return None
    if name != "APIRouter":
        return None
    for kw in call.keywords:
        if kw.arg == "prefix":
            p = literal_str(kw.value, constants)
            if p is not None:
                return p
    if call.args:
        p = literal_str(call.args[0], constants)
        if p is not None:
            return p
    return None


def flask_route_from_decorator(dec, constants):
    """Flask @app.route('/path', methods=[...]) / @bp.route(...). Method shortcuts (@app.get) are
    handled by the FastAPI method-decorator path. Returns path, methods, receiver, line."""
    if not isinstance(dec, ast.Call):
        return None
    func = dec.func
    if not isinstance(func, ast.Attribute) or func.attr != "route":
        return None
    if not dec.args:
        return None
    path = literal_str(dec.args[0], constants)
    if path is None:
        return None
    methods = ["GET"]
    for kw in dec.keywords:
        if kw.arg == "methods":
            parsed = parse_http_methods_list(kw.value, constants)
            if parsed:
                methods = parsed
    receiver = func.value.id if isinstance(func.value, ast.Name) else None
    return {"path": path, "methods": methods, "receiver": receiver, "line": dec.lineno}


def register_blueprint_extra_prefix(call, constants):
    """Flask app.register_blueprint(bp, url_prefix='/admin') -> (bp_var, extra_prefix)."""
    if not isinstance(call, ast.Call):
        return None
    func = call.func
    if not isinstance(func, ast.Attribute) or func.attr != "register_blueprint":
        return None
    if not call.args or not isinstance(call.args[0], ast.Name):
        return None
    bp_var = call.args[0].id
    extra = ""
    for kw in call.keywords:
        if kw.arg == "url_prefix":
            p = literal_str(kw.value, constants)
            if p is not None:
                extra = p
    return (bp_var, extra)


def resolve_pattern_elts(node, pattern_lists):
    if isinstance(node, (ast.List, ast.Tuple)):
        return list(node.elts)
    if isinstance(node, ast.Name) and node.id in pattern_lists:
        return list(pattern_lists[node.id])
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = resolve_pattern_elts(node.left, pattern_lists)
        right = resolve_pattern_elts(node.right, pattern_lists)
        if left is not None and right is not None:
            return left + right
    return None


def django_route_path(mount, path, is_regex=False):
    if is_regex or path.startswith("^"):
        if not mount:
            return path
        return mount.rstrip("/") + path
    return join_paths(mount, path)


def append_django_path_route(dp, mount, constants, api_view_methods, routes):
    path = django_route_path(mount, dp["path"], dp.get("is_regex"))
    view = dp.get("view")
    methods = api_view_methods.get(view, [dp["method"]]) if view else [dp["method"]]
    component = view if view else "(django-view)"
    for method in methods:
        routes.append(
            {
                "path": path,
                "method": method,
                "component": component,
                "line": dp.get("line"),
            }
        )


def expand_pattern_elements(elts, mount, constants, pattern_lists, routes, drf_mounts, api_view_methods):
    for el in elts:
        inc = django_path_include_router_urls(el, constants)
        if inc is not None:
            mount_prefix, target, kind = inc
            combined = join_paths(mount, mount_prefix)
            if kind == "router":
                drf_mounts[target] = combined
            elif kind == "patterns" and target in pattern_lists:
                expand_pattern_elements(
                    pattern_lists[target], combined, constants, pattern_lists, routes, drf_mounts, api_view_methods
                )
            continue
        dp = django_path_from_call(el, constants)
        if dp is None:
            continue
        append_django_path_route(dp, mount, constants, api_view_methods, routes)


def collect_pattern_lists(tree):
    pattern_lists = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for t in node.targets:
            if isinstance(t, ast.Name) and isinstance(node.value, (ast.List, ast.Tuple)):
                pattern_lists[t.id] = node.value.elts
    return pattern_lists


def looks_like_template(name):
    return any(name.endswith(ext) for ext in TEMPLATE_EXTENSIONS)


def template_names_from_call(node, constants):
    """String-literal template names rendered by a single call node, or []."""
    if not isinstance(node, ast.Call):
        return []
    func = node.func
    fname = func.id if isinstance(func, ast.Name) else (func.attr if isinstance(func, ast.Attribute) else None)
    if fname is None:
        return []
    out = []
    if fname in DJANGO_TEMPLATE_VIEW_FUNCS:
        # render(request, "tpl", ctx) -> arg 1; render_to_string("tpl", ...) -> arg 0.
        idx = 1 if fname == "render" else 0
        if len(node.args) > idx:
            t = literal_str(node.args[idx], constants)
            if t is not None:
                out.append(t)
    elif fname == "render_template":
        # Flask: render_template("a.html"[, "b.html"], **ctx).
        for a in node.args:
            t = literal_str(a, constants)
            if t is not None and looks_like_template(t):
                out.append(t)
    elif fname == "TemplateResponse":
        # Django: TemplateResponse(request, "tpl", ctx); Starlette/FastAPI: TemplateResponse("tpl", {...})
        # or TemplateResponse(request, "tpl"). Arg order varies, so disambiguate by extension.
        for a in node.args[:2]:
            t = literal_str(a, constants)
            if t is not None and looks_like_template(t):
                out.append(t)
        for kw in node.keywords:
            if kw.arg in ("name", "template_name"):
                t = literal_str(kw.value, constants)
                if t is not None:
                    out.append(t)
    return out


def templates_in_body(func_node, constants):
    out = []
    for n in ast.walk(func_node):
        out.extend(template_names_from_call(n, constants))
    return out


def cbv_template_attrs(class_node, constants):
    out = []
    for item in class_node.body:
        if isinstance(item, ast.Assign):
            for t in item.targets:
                if isinstance(t, ast.Name) and t.id == "template_name":
                    s = literal_str(item.value, constants)
                    if s is not None:
                        out.append(s)
                elif isinstance(t, ast.Name) and t.id == "template_names" and isinstance(item.value, (ast.List, ast.Tuple)):
                    for el in item.value.elts:
                        s = literal_str(el, constants)
                        if s is not None:
                            out.append(s)
        elif isinstance(item, ast.AnnAssign):
            if isinstance(item.target, ast.Name) and item.target.id == "template_name" and item.value is not None:
                s = literal_str(item.value, constants)
                if s is not None:
                    out.append(s)
    return out


def collect_view_templates(tree, constants):
    """Map a view function/class name to its rendered template names (same-file rendering only)."""
    view_templates = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            tmpls = templates_in_body(node, constants)
            if tmpls:
                view_templates[node.name] = sorted(set(tmpls))
        elif isinstance(node, ast.ClassDef):
            tmpls = list(cbv_template_attrs(node, constants))
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    tmpls.extend(templates_in_body(item, constants))
            if tmpls:
                view_templates[node.name] = sorted(set(tmpls))
    return view_templates


def attach_render_templates(routes, view_templates):
    """Attach rendersTemplate to routes whose view (component) renders templates in the same file."""
    if not view_templates:
        return
    for r in routes:
        comp = r.get("component") or ""
        tmpls = view_templates.get(comp)
        if tmpls is None and "." in comp:
            tmpls = view_templates.get(comp.split(".")[0])
        if tmpls:
            r["rendersTemplate"] = tmpls


out = []
for line in sys.stdin.read().splitlines():
    fp = line.strip()
    if not fp:
        continue
    try:
        with open(fp, "rb") as f:
            tree = ast.parse(f.read(), filename=fp)
    except Exception as e:
        out.append({"filePath": fp, "error": str(e)})
        continue

    imports = []
    exports = []
    dunder_all = []
    for node in tree.body:
        if isinstance(node, ast.Import):
            for n in node.names:
                imports.append({"module": n.name, "level": 0, "names": [n.asname or n.name], "kind": "import"})
        elif isinstance(node, ast.ImportFrom):
            imports.append(
                {
                    "module": node.module or "",
                    "level": node.level or 0,
                    "names": [a.asname or a.name for a in node.names],
                    "kind": "from",
                }
            )
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            exports.append(
                {
                    "name": node.name,
                    "kind": "function",
                    "line": node.lineno,
                    "endLine": getattr(node, "end_lineno", node.lineno),
                }
            )
        elif isinstance(node, ast.ClassDef):
            exports.append(
                {
                    "name": node.name,
                    "kind": "class",
                    "line": node.lineno,
                    "endLine": getattr(node, "end_lineno", node.lineno),
                }
            )
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id == "__all__" and isinstance(node.value, (ast.List, ast.Tuple)):
                    for el in node.value.elts:
                        if isinstance(el, ast.Constant) and isinstance(el.value, str):
                            dunder_all.append(
                                {
                                    "name": el.value,
                                    "line": node.lineno,
                                    "endLine": getattr(node, "end_lineno", node.lineno),
                                }
                            )
                elif isinstance(t, ast.Name) and not is_dunder(t.id):
                    exports.append(
                        {
                            "name": t.id,
                            "kind": "const",
                            "line": node.lineno,
                            "endLine": getattr(node, "end_lineno", node.lineno),
                        }
                    )
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name) and not is_dunder(node.target.id):
                exports.append(
                    {
                        "name": node.target.id,
                        "kind": "const",
                        "line": node.lineno,
                        "endLine": getattr(node, "end_lineno", node.lineno),
                    }
                )

    env_vars = set()
    for node in ast.walk(tree):
        name = env_name_from(node)
        if name is not None:
            env_vars.add(name)

    constants = collect_string_constants(tree)
    custom_router_classes = collect_custom_router_classes(tree)
    pattern_lists = collect_pattern_lists(tree)
    api_view_methods = collect_api_view_methods(tree, constants)
    framework = detect_framework(imports)
    view_templates = collect_view_templates(tree, constants)

    router_prefixes = {}
    include_extra_prefixes = {}
    drf_router_vars = {}
    drf_router_routes = {}
    drf_mounts = {}
    viewset_registrations = {}
    routes = []

    for node in tree.body:
        calls = []
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            calls.append(node.value)
        elif isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
            calls.append(node.value)
        for call in calls:
            ir = include_router_extra_prefix(call, constants)
            if ir is not None:
                include_extra_prefixes[ir[0]] = ir[1]
            rb = register_blueprint_extra_prefix(call, constants)
            if rb is not None:
                include_extra_prefixes[rb[0]] = rb[1]
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and isinstance(node.value, ast.Call):
                    kind = drf_router_kind_from_call(node.value, custom_router_classes)
                    if kind is not None:
                        drf_router_vars[t.id] = kind
                    prefix = router_prefix_from_call(node.value, constants)
                    if prefix is not None:
                        router_prefixes[t.id] = prefix
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name) and isinstance(node.value, ast.Call):
                t = node.target
                kind = drf_router_kind_from_call(node.value, custom_router_classes)
                if kind is not None:
                    drf_router_vars[t.id] = kind
                prefix = router_prefix_from_call(node.value, constants)
                if prefix is not None:
                    router_prefixes[t.id] = prefix
        for call in calls:
            for ar in fastapi_add_api_routes(call, constants) or []:
                receiver = ar.get("receiver") or ""
                full_path = join_paths(
                    include_extra_prefixes.get(receiver, ""),
                    join_paths(router_prefixes.get(receiver, ""), ar["path"]),
                )
                routes.append(
                    {
                        "path": full_path,
                        "method": ar["method"],
                        "component": ar["component"],
                        "line": ar.get("line"),
                    }
                )
            reg = drf_register_info(call, constants)
            if reg is None or reg["router"] not in drf_router_vars:
                continue
            router_kind = drf_router_vars[reg["router"]]
            drf_router_routes.setdefault(reg["router"], []).extend(
                drf_routes_from_register(reg["prefix"], reg["viewset"], reg.get("line"), router_kind)
            )
            viewset_registrations.setdefault(reg["viewset"], []).append(
                {"prefix": reg["prefix"], "router": reg["router"], "line": reg.get("line")}
            )

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for dec in node.decorator_list:
                matched = False
                for extractor in (fastapi_route_from_decorator, fastapi_websocket_from_decorator):
                    fr = extractor(dec, constants)
                    if fr is None:
                        continue
                    receiver = fr.get("receiver") or ""
                    full_path = join_paths(
                        include_extra_prefixes.get(receiver, ""),
                        join_paths(router_prefixes.get(receiver, ""), fr["path"]),
                    )
                    routes.append(
                        {
                            "path": full_path,
                            "method": fr["method"],
                            "component": node.name,
                            "line": fr.get("line"),
                        }
                    )
                    matched = True
                    break
                if matched:
                    continue
                fl = flask_route_from_decorator(dec, constants)
                if fl is not None:
                    receiver = fl.get("receiver") or ""
                    full_path = join_paths(
                        include_extra_prefixes.get(receiver, ""),
                        join_paths(router_prefixes.get(receiver, ""), fl["path"]),
                    )
                    for method in fl["methods"]:
                        routes.append(
                            {
                                "path": full_path,
                                "method": method,
                                "component": node.name,
                                "line": fl.get("line"),
                            }
                        )
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id == "urlpatterns":
                    elts = resolve_pattern_elts(node.value, pattern_lists)
                    if elts is not None:
                        expand_pattern_elements(
                            elts, "", constants, pattern_lists, routes, drf_mounts, api_view_methods
                        )
        if isinstance(node, ast.AugAssign):
            if isinstance(node.target, ast.Name) and node.target.id == "urlpatterns":
                elts = resolve_pattern_elts(node.value, pattern_lists)
                if elts is not None:
                    expand_pattern_elements(
                        elts, "", constants, pattern_lists, routes, drf_mounts, api_view_methods
                    )

    for router_var, route_list in drf_router_routes.items():
        mount = drf_mounts.get(router_var, "")
        for r in route_list:
            routes.append(
                {
                    "path": join_paths(mount, r["path"]),
                    "method": r["method"],
                    "component": r["component"],
                    "line": r.get("line"),
                }
            )

    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        registrations = viewset_registrations.get(node.name)
        if not registrations:
            continue
        for reg in registrations:
            mount = drf_mounts.get(reg["router"], "")
            for item in node.body:
                if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                for dec in item.decorator_list:
                    action = drf_action_info(dec, constants)
                    if action is None:
                        continue
                    path = drf_action_paths(
                        mount,
                        reg["prefix"],
                        action["detail"],
                        action.get("url_path"),
                        item.name,
                    )
                    for method in action["methods"]:
                        routes.append(
                            {
                                "path": path,
                                "method": method,
                                "component": node.name + "." + item.name,
                                "line": action.get("line"),
                            }
                        )

    attach_render_templates(routes, view_templates)
    routes.sort(key=lambda r: (r.get("path") or "", r.get("method") or "", r.get("component") or ""))
    out.append(
        {
            "filePath": fp,
            "imports": imports,
            "exports": exports,
            "envVars": sorted(env_vars),
            "dunderAll": dunder_all,
            "framework": framework,
            "routes": routes,
        }
    )

sys.stdout.write(json.dumps(out))
