import { Ionicons } from "@expo/vector-icons";
import { cssInterop } from "nativewind";

export type Glyph = keyof typeof Ionicons.glyphMap;

// Ionicons isn't NativeWind-aware, so without this its text-* class is dropped and every
// glyph renders black. app/_layout.tsx imports this module for the side effect
cssInterop(Ionicons, { className: { target: "style", nativeStyleToProp: { color: true } } });
