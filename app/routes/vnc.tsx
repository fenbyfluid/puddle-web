import type { Route } from "./+types/vnc";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "VNC - Puddle" },
  ];
}

export default function VNC() {
  return (
    <div className="p-4">
      <h1 className="text-2xl font-semibold text-gray-900">VNC</h1>
      <p className="mt-2 text-gray-600">This page will be filled with VNC content later.</p>
    </div>
  );
}
