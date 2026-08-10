export const enum SetupType {
    Door = 1,
    DoorScale = 2,
    Weapon = 8,
    Guard = 9,
    SingleMonitor = 10,
    MultiMonitor = 11,
    Hat = 17,
    Glass = 42,
    TintedGlass = 47,
    End = 48,
}

export const enum ModelNodeType {
    BoundingBox = 0x0A,
    DisplayList = 0x0D,
    Distance = 0x12,
    GunFirePosition = 0x15,
    Position = 0x16,
    HeadSpot = 0x17,
    Attachment = 0x18,
}

export const enum Fast3DOpcode {
    Matrix = 0x01,
    Vertex = 0x04,
    DisplayList = 0x06,
    Triangle2 = 0xB1,
    ClearGeometryMode = 0xB6,
    SetGeometryMode = 0xB7,
    EndDisplayList = 0xB8,
    SetOtherModeLow = 0xB9,
    SetOtherModeHigh = 0xBA,
    Texture = 0xBB,
    Triangle1 = 0xBF,
    GoldenEyeTexture = 0xC0,
    SetPrimColor = 0xFA,
    SetEnvColor = 0xFB,
    SetCombine = 0xFC,
}

export const enum MonitorCommand {
    ResetPosition = 0,
    MoveX = 1,
    MoveY = 2,
    SetX = 3,
    SetY = 4,
    ScaleX = 5,
    ScaleY = 6,
    SetImage = 7,
    Pause = 8,
    Jump = 9,
    RandomJump = 10,
    Restart = 11,
    Stop = 12,
    SetColor = 13,
    SetRotation = 14,
    Rotate = 15,
}

export const enum PropFlag {
    SampleUndarkened = 0x00000400,
    AssignedToCharacter = 0x00004000,
    Embedded = 0x00008000,
    AlternateAttachment = 0x10000000,
    AlternateDoorHinge = 0x20000000,
    InitiallyOpen = 0x80000000,
}

export const enum AttachmentSlot {
    RightHand = 3,
    AlternateHand = 5,
    Hat = 6,
}
