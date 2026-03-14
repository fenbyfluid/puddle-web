import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  index("routes/index.tsx"),
  layout("routes/layout.tsx", [
    route("monitor", "routes/monitor.tsx"),
    route("vnc", "routes/vnc.tsx"),
  ]),
] satisfies RouteConfig;
