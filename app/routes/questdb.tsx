import type { Route } from "./+types/questdb";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "QuestDB - Puddle" },
  ];
}

export default function QuestDB() {
  return (
    <div className="flex-grow overflow-hidden relative">
      <iframe
        src="/questdb/"
        className="absolute inset-0 w-full h-full border-0"
        title="QuestDB"
      />
    </div>
  );
}
