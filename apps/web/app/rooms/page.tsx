import { redirect } from "next/navigation";

// /rooms has no listing UI — redirect to home where the room list lives
export default function RoomsIndexPage() {
  redirect("/");
}
