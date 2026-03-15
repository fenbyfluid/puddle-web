import { redirect } from "react-router";

export function clientLoader() {
  return redirect("/control");
}

export default function Index() {
  return null;
}
