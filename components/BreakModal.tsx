import React, { useState, useEffect, useCallback, useRef } from "react";
import { View, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ICON_SIZE, spacing } from "@/utils/design-tokens";
import { TimerDisplay } from "./ui/TimerDisplay";
import { SheetFrame } from "./ui/SheetFrame";
import { SubPanel } from "./ui/SubPanel";
import { Button } from "./ui/Button";

interface BreakModalProps {
  visible: boolean;
  onClose: () => void;
  defaultMinutes?: number;
}

const CALMING_PROMPTS = [
  { icon: "cloudy-outline" as const, text: "Take 5 deep breaths. In through your nose, out through your mouth." },
  { icon: "body-outline" as const, text: "Stand up and stretch. Roll your shoulders back. Shake out your hands." },
  { icon: "eye-outline" as const, text: "Look away from the screen. Find something green and focus on it for 20 seconds." },
];

const SKIP_UNLOCK_SECONDS = 60;

export function BreakModal({
  visible,
  onClose,
  defaultMinutes = 5,
}: BreakModalProps) {
  const totalSeconds = defaultMinutes * 60;
  const [secondsLeft, setSecondsLeft] = useState(totalSeconds);
  const [isRunning, setIsRunning] = useState(true);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [prompt] = useState(
    () => CALMING_PROMPTS[Math.floor(Math.random() * CALMING_PROMPTS.length)]
  );
  const hasAutoClosedRef = useRef(false);

  useEffect(() => {
    if (visible) {
      setSecondsLeft(totalSeconds);
      setElapsedSeconds(0);
      setIsRunning(true);
      hasAutoClosedRef.current = false;
    }
  }, [visible, totalSeconds]);

  useEffect(() => {
    if (!isRunning || !visible) return;
    const interval = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          setIsRunning(false);
          return 0;
        }
        return prev - 1;
      });
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning, visible]);

  useEffect(() => {
    if (secondsLeft === 0 && visible && !hasAutoClosedRef.current) {
      hasAutoClosedRef.current = true;
      onClose();
    }
  }, [secondsLeft, visible, onClose]);

  const handleResume = useCallback(() => {
    onClose();
  }, [onClose]);

  const canSkip = elapsedSeconds >= SKIP_UNLOCK_SECONDS;

  return (
    <SheetFrame
      visible={visible}
      title="Take a breather"
      onClose={handleResume}
      footer={
        <>
          <Button title="Resume" variant="primary" onPress={handleResume} accessibilityLabel="Resume focus session" />
          {canSkip && (
            <Button
              title="Skip remaining time"
              variant="ghost"
              onPress={handleResume}
              accessibilityLabel="Skip remaining break time"
            />
          )}
          <Button
            title={isRunning ? "Pause timer" : "Unpause timer"}
            variant="ghost"
            onPress={() => setIsRunning((r) => !r)}
            accessibilityLabel={isRunning ? "Pause break timer" : "Resume break timer"}
          />
        </>
      }
    >
      <View style={{ gap: spacing.base }}>
        <TimerDisplay seconds={secondsLeft} running={isRunning} label="Time remaining" />
        <SubPanel label="While you wait">
          <View className="flex-row items-start">
            <Ionicons name={prompt.icon} size={ICON_SIZE.row} className="text-content dark:text-content-dark-primary" />
            <Text className="flex-1 text-body font-sans text-content dark:text-content-dark-primary" style={{ marginLeft: spacing.md }}>
              {prompt.text}
            </Text>
          </View>
        </SubPanel>
      </View>
    </SheetFrame>
  );
}
