export default {
  id: "oldman",
  name: "The Old Man and the Sea",
  file: "The Old Man and the Sea.pdf",
  /** Hemingway PDF sets isIndented on nearly every prose block; skip rate sampling. */
  skipGeneralChecks: ["indentationConsistency"],
  assertions: [
    [
      "no asiaing watermark",
      (ctx) => !/asiaing/i.test(ctx.joined),
    ],
    [
      "No Asiaing watermark in any block",
      (ctx) => !ctx.blocks.some((block) => /asiaing/i.test(block.text ?? "")),
    ],
    [
      "permanent defeat merged",
      (ctx) => {
        const block = ctx.blocks.find((entry) =>
          /permanent defeat/.test(entry.text ?? "")
        )
        return (
          Boolean(block) &&
          !block.isHeading &&
          /it looked/i.test(block.text ?? "")
        )
      },
    ],
    [
      "eyes sentence merged",
      (ctx) => {
        const block = ctx.blocks.find((entry) =>
          /cheerful and undefeated/.test(entry.text ?? "")
        )
        return (
          Boolean(block) && /Everything about him was old/.test(block.text ?? "")
        )
      },
    ],
    [
      "dialogue split",
      (ctx) => {
        const eyes = ctx.blocks.find((entry) =>
          /Are his eyes that bad/.test(entry.text ?? "")
        )
        return Boolean(eyes) && (eyes.text ?? "").length < 120
      },
    ],
    [
      "dedication lines present",
      (ctx) => {
        const joined = ctx.blocks.map((entry) => entry.text ?? "").join(" ")
        return /To Charlie Shribner/i.test(joined) && /Max Perkins/i.test(joined)
      },
    ],
    [
      "no false narrative headings",
      (ctx) =>
        !ctx.blocks.some(
          (entry) =>
            entry.isHeading &&
            /Terrace and asked for a can of coffee|Finally the old man woke|sun was hot now although the breeze|Not in the absolute dark\. But almost|heavy brisa have we|How much did you suffer/.test(
              entry.text ?? ""
            )
        ),
    ],
    [
      "Word count above 25000",
      (ctx) => ctx.wordCount > 25000,
    ],
  ],
}
