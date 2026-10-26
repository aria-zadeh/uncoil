import React from "react";
import { View, Text, useWindowDimensions } from "react-native";
import { spacing, typography, HAIRLINE, GUTTER_WIDTH } from "@/utils/design-tokens";

export interface TimeGutterProps {
  // 0 to 23
  hour: number;
}

// gutters sit at a fixed hour pitch. uncapped, the labels outgrew it and overlapped the next hour
const MAX_FONT_SCALE = 1.6;

const SHORT_FORM_FONT_SCALE = 1.3;

// wide enough for the short form at MAX_FONT_SCALE
const GUTTER_WIDTH_LARGE = GUTTER_WIDTH + 32;

// exported so calendar.tsx keeps the track geometry in step with the widened gutter
export function getGutterWidth(fontScale: number): number {
  return fontScale >= SHORT_FORM_FONT_SCALE ? GUTTER_WIDTH_LARGE : GUTTER_WIDTH;
}

export function formatGutterHour(hour: number): { time: string; period: string } {
  const period = hour >= 12 ? "PM" : "AM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return { time: `${String(twelve).padStart(2, "0")}:00`, period };
}

export function formatGutterHourShort(hour: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${period}`;
}

export function TimeGutter({ hour }: TimeGutterProps) {
  const { fontScale } = useWindowDimensions();
  const short = fontScale >= SHORT_FORM_FONT_SCALE;
  const { time, period } = formatGutterHour(hour);
  return (
    <View className="flex-row items-start" accessibilityLabel={`${time} ${period}`}>
      <View style={{ width: getGutterWidth(fontScale), paddingRight: spacing.sm }}>
        {short ? (
          <Text
            className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary text-right"
            style={{ fontVariant: ["tabular-nums"] }}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            numberOfLines={1}
          >
            {formatGutterHourShort(hour)}
          </Text>
        ) : (
          <>
            <Text
              className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary text-right"
              style={{ fontVariant: ["tabular-nums"] }}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              numberOfLines={1}
            >
              {time}
            </Text>
            <Text
              className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary text-right"
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              numberOfLines={1}
            >
              {period}
            </Text>
          </>
        )}
      </View>
      <View
        className="flex-1 bg-border dark:bg-border-dark"
        style={{ height: HAIRLINE, marginTop: typography.caption.lineHeight / 2 }}
      />
    </View>
  );
}
