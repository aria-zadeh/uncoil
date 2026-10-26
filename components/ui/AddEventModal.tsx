import React from "react";
import { AddEventForm, type NewBusyTime } from "@/components/ui/AddEventForm";
import { SheetFrame } from "@/components/ui/SheetFrame";

interface AddEventModalProps {
  visible: boolean;
  onClose: () => void;
  onAdd: (event: NewBusyTime) => void;
  initialDate?: Date;
  initialStart?: Date;
}

// screens that already show a sheet render AddEventForm inside it instead. iOS won't
// present a second Modal over one on screen and leaves an invisible sheet that eats touches.
// the key remount is what resets the fields between openings
export function AddEventModal({ visible, onClose, onAdd, initialDate, initialStart }: AddEventModalProps) {
  return (
    <SheetFrame visible={visible} title="Add busy time" onClose={onClose}>
      <AddEventForm
        key={visible ? "open" : "closed"}
        onSubmit={(event) => {
          onAdd(event);
          onClose();
        }}
        initialDate={initialDate}
        initialStart={initialStart}
      />
    </SheetFrame>
  );
}
