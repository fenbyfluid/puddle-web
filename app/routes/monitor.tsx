import type { Route } from "./+types/monitor";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Monitor - Puddle" },
  ];
}

export default function Monitor() {
  return (
    <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8 w-full">
      <div className="flex flex-col items-center justify-center min-h-[50vh] text-center">
        <div className="bg-white p-8 rounded-2xl shadow-sm border border-gray-100 max-w-md w-full text-gray-500">
          This is a placeholder for the monitor interface.
        </div>
      </div>
    </div>
  );
}
