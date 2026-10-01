// The four grades, kept in their own module so `algorithm.ts` can name the grade
// type without pulling in the FSRS engine. That matters: importing the grade
// type at a call site should not drag `ts-fsrs` into the bundle.

export type ReviewGrade = "again" | "hard" | "good" | "easy";
