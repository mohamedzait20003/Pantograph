import { z } from 'zod';

/**
 * Input and output names become `{{param}}` tokens and JSON Schema property
 * names, so they are constrained to identifiers rather than free strings.
 */
export const IoNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, {
  error: 'Input and output names must be identifiers (letters, digits, underscore).',
});

export const InputTypeSchema = z.enum(['string', 'number', 'boolean', 'enum']);

export const InputSpecSchema = z.object({
  type: InputTypeSchema,
  required: z.boolean(),
  description: z.string().min(1),
  pattern: z.string().optional(),
  enum: z.array(z.string().min(1)).optional(),
  example: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).superRefine((spec, ctx) => {
  if (spec.type === 'enum' && (!spec.enum || spec.enum.length === 0)) {
    ctx.addIssue({
      code: 'custom',
      message: "An input of type 'enum' must list its allowed values in `enum`.",
      path: ['enum'],
    });
  }

  if (spec.type !== 'enum' && spec.enum) {
    ctx.addIssue({
      code: 'custom',
      message: "`enum` is only meaningful on an input of type 'enum'.",
      path: ['enum'],
    });
  }

  if (spec.type !== 'string' && spec.pattern) {
    ctx.addIssue({
      code: 'custom',
      message: "`pattern` is only meaningful on an input of type 'string'.",
      path: ['pattern'],
    });
  }
});

/**
 * `money` is deliberately not `number`.
 *
 * A balance renders as `8,417.32` — a string with separators. Parsing it into a
 * float to satisfy a `number` type loses the original representation, invites
 * locale bugs (`1.234,56`), and introduces binary floating point into a
 * financial value. `money` means: carry the string through verbatim, and let
 * the caller decide how to interpret it. Conflating the two is exactly the kind
 * of quiet, plausible-looking bug this system exists to avoid.
 */
export const OutputTypeSchema = z.enum(['string', 'number', 'money', 'boolean']);

export const OutputSpecSchema = z.object({
  type: OutputTypeSchema,
  description: z.string().min(1),
});

export type IoName = z.infer<typeof IoNameSchema>;
export type InputType = z.infer<typeof InputTypeSchema>;
export type InputSpec = z.infer<typeof InputSpecSchema>;
export type OutputType = z.infer<typeof OutputTypeSchema>;
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

/**
 * Converts a capability's declared inputs into a JSON Schema suitable for use
 * as a function-calling signature.
 *
 * This is the bridge that makes a recorded artifact directly invocable by an
 * agent: the same `inputs` block a human reviews in a pull request becomes the
 * tool definition, with no second hand-maintained copy to drift out of sync.
 */
export function inputsToJsonSchema(
  inputs: Record<string, InputSpec>,
): Record<string, unknown> {
  const shape: Record<string, z.ZodType> = {};

  for (const [name, spec] of Object.entries(inputs)) {
    let base: z.ZodType;

    switch (spec.type) {
      case 'string': {
        const asString = z.string();
        base = spec.pattern ? asString.regex(new RegExp(spec.pattern)) : asString;
        break;
      }
      case 'number':
        base = z.number();
        break;
      case 'boolean':
        base = z.boolean();
        break;
      case 'enum': {
        if (!spec.enum || spec.enum.length === 0) {
          throw new Error(`Input '${name}' is type 'enum' but declares no values.`);
        }
        
        base = z.enum(spec.enum as [string, ...string[]]);
        break;
      }
    }

    base = base.meta({
      description: spec.description,
      ...(spec.example !== undefined ? { examples: [spec.example] } : {}),
    });

    shape[name] = spec.required ? base : base.optional();
  }

  return z.toJSONSchema(z.object(shape));
}
