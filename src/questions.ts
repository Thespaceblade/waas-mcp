export type FormFieldType =
  | "message"
  | "text"
  | "long_text"
  | "url"
  | "multiple_choice"
  | "unknown";

export type FormField = {
  id: string;
  name: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  maxLength?: number;
  options?: { id: number; label: string }[];
};

export type CustomQuestion = {
  id: number;
  question_type: string;
  label: string;
  required: boolean;
  archived_at?: string | null;
  options?: { id: number; label: string }[];
};

export function customQuestionsToFields(questions: CustomQuestion[]): FormField[] {
  return questions
    .filter((q) => !q.archived_at)
    .map((q) => ({
      id: String(q.id),
      name: `question_${q.id}`,
      label: q.label.trim(),
      type: mapQuestionType(q.question_type),
      required: Boolean(q.required),
      options: q.options?.map((o) => ({ id: o.id, label: o.label })),
    }));
}

function mapQuestionType(questionType: string): FormFieldType {
  switch (questionType) {
    case "text":
      return "text";
    case "long_text":
      return "long_text";
    case "url":
      return "url";
    case "multiple_choice":
      return "multiple_choice";
    default:
      return "unknown";
  }
}
