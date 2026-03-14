import { NavLink, Outlet } from "react-router";

export default function Layout() {
  const tabs = [
    { name: "Monitor", href: "/monitor" },
    { name: "VNC", href: "/vnc" },
    { name: "QuestDB", href: "/questdb", external: true },
  ];

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <div className="flex-shrink-0 flex items-center">
              <span className="text-xl font-bold text-brand-600">Puddle</span>
            </div>
            <nav className="flex space-x-8">
              {tabs.map((tab) => (
                tab.external ? (
                  <a
                    key={tab.name}
                    href={tab.href}
                    className="inline-flex items-center px-1 pt-1 border-b-2 border-transparent text-sm font-medium text-gray-500 hover:text-gray-700 hover:border-gray-300"
                  >
                    {tab.name}
                  </a>
                ) : (
                  <NavLink
                    key={tab.name}
                    to={tab.href}
                    className={({ isActive }) =>
                      `inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium ${
                        isActive
                          ? "border-brand-600 text-gray-900"
                          : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                      }`
                    }
                  >
                    {tab.name}
                  </NavLink>
                )
              ))}
            </nav>
          </div>
        </div>
      </header>

      <main className="flex-grow">
        <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
