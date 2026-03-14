import { redirect } from "react-router";

export function clientLoader() {
  return redirect("/monitor");
}

export default function Index() {
  return null;
}
