export const pages = [
  [
    "home",
    "Home",
    "home",
    "Workspace",
    "Your day, a little easier.",
    "Ask a question, find something, or think through your next step.",
  ],
  [
    "voice",
    "Voice Studio",
    "wave",
    "Workspace",
    "Voice Studio",
    "Speak naturally. You can interrupt Edith at any time.",
  ],
  [
    "conversations",
    "Conversations",
    "message",
    "Workspace",
    "Conversations",
    "Revisit the dialogue from this open workspace.",
  ],
  [
    "tasks",
    "Task Center",
    "checklist",
    "Productivity",
    "Task Center",
    "Review work and the steps that need your attention.",
  ],
  [
    "automations",
    "Automations",
    "flow",
    "Productivity",
    "Automations",
    "Manage recurring work and its execution history.",
  ],
  [
    "calendar",
    "Calendar",
    "calendar",
    "Productivity",
    "Calendar",
    "Your schedules and calendar connections.",
  ],
  [
    "files",
    "Files",
    "folder",
    "Intelligence",
    "Files",
    "Search filename metadata in your authorized Windows folders.",
  ],
  [
    "knowledge",
    "Knowledge",
    "book",
    "Intelligence",
    "Knowledge",
    "Collections of documents you choose to share with Edith.",
  ],
  [
    "memory",
    "Memory",
    "layers",
    "Intelligence",
    "Memory",
    "Inspect the information Edith can carry between sessions.",
  ],
  [
    "integrations",
    "Integrations",
    "plug",
    "Connections",
    "Integrations",
    "See which services are available in this workspace.",
  ],
  [
    "devices",
    "Devices",
    "monitor",
    "Connections",
    "Devices",
    "See where Edith can access files.",
  ],
  [
    "skills",
    "Skills",
    "spark",
    "Connections",
    "Skills",
    "Explore the capabilities available here.",
  ],
  [
    "activity",
    "Activity",
    "pulse",
    "System",
    "Activity",
    "Events observed since you opened this workspace.",
  ],
  [
    "permissions",
    "Permissions",
    "shield",
    "System",
    "Permissions",
    "Review current access and permission boundaries.",
  ],
  [
    "notifications",
    "Notifications",
    "bell",
    "System",
    "Notifications",
    "Updates that need your attention.",
  ],
  [
    "settings",
    "Settings",
    "settings",
    "System",
    "Settings",
    "Adjust how this workspace displays your conversation.",
  ],
  ["help", "Help", "help", "System", "Help", "Using your EDITH OS workspace."],
];
const paths = {
  home: "M3 10l9-7 9 7v10h-6v-7H9v7H3z",
  wave: "M3 10v4m4-8v12m5-16v20m5-16v12m4-8v4",
  message: "M4 4h16v12H9l-5 4z",
  checklist: "M3 6l2 2 3-4m3 3h10M3 15l2 2 3-4m3 3h10",
  flow: "M3 3h6v6H3zM15 15h6v6h-6zM6 9v7h9",
  calendar: "M3 5h18v16H3zM7 3v4m10-4v4M3 10h18",
  folder: "M3 6h7l2 3h9v11H3z",
  book: "M12 6Q7 3 3 5v14q5-2 9 1 4-3 9-1V5q-4-2-9 1v14",
  layers: "m2 8 10-5 10 5-10 5zM3 12l9 5 9-5M3 16l9 5 9-5",
  plug: "m8 3 3 3m4-1 3 3M6 11l7-7 7 7-7 7a5 5 0 0 1-7-7zm1 6-5 5",
  monitor: "M3 4h18v13H3zM8 21h8m-4-4v4",
  spark: "m12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7z",
  pulse: "M2 12h5l3-7 4 14 3-7h5",
  shield: "M12 2l8 3v6q0 6-8 11-8-5-8-11V5zM8 11l3 3 5-6",
  bell: "M4 17h16l-2-4V9a6 6 0 0 0-12 0v4zM10 20q2 3 4 0",
  settings: "M3 7h18M3 17h18M8 4v6m8 4v6",
  help: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM9 9q0-3 3-3 4 0 3 4-1 2-3 3v1m0 3h.01",
  search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0zm-2 5 6 6",
  mic: "M9 6a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zM5 11v1a7 7 0 0 0 14 0v-1m-7 8v3m-4 0h8",
  panel: "M3 4h18v16H3zM9 4v16",
  chevron: "m9 6 6 6-6 6",
  diagonal: "M6 18 18 6M8 6h10v10",
  "arrow-right": "M4 12h16m-6-6 6 6-6 6",
  "arrow-up": "M12 20V4m-6 6 6-6 6 6",
  orb: "M19 5C8-3-4 12 5 19c10 9 23-6 14-14ZM18 5C12 1 0 14 6 19c6 5 19-9 12-14ZM17 6C14 4 3 16 7 18c4 3 15-10 10-12Z",
  more: "M4 12h1m6 0h1m6 0h1",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 6v6l4 2",
};
export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
}
export function link(id, label, glyph) {
  const a = document.createElement("a");
  a.href = id === "home" ? "/app" : "/app/" + id;
  if (glyph) a.append(icon(glyph));
  const span = document.createElement("span");
  span.textContent = label;
  a.append(span);
  a.title = label;
  return a;
}
