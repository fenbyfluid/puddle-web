import type { Route } from "./+types/monitor";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Monitor - Puddle" },
  ];
}

export default function Monitor() {
  return (
    <div className="p-4">
      <h1 className="text-2xl font-semibold text-gray-900">Monitor</h1>
      <p className="mt-2 text-gray-600">This page will be filled with monitoring content later.</p>
    </div>
  );
}
