import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/index.tsx"),
  layout("routes/layout.tsx", [
    route("control", "routes/control.tsx"),
    route("monitor", "routes/monitor.tsx"),
    route("vnc", "routes/vnc.tsx"),
    route("questdb", "routes/questdb.tsx"),
  ]),
] satisfies RouteConfig;
