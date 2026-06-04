export default {
  id: "pride-prejudice",
  name: "Pride and Prejudice",
  file: "PrideAndPrejudice.pdf",
  assertions: [
    [
      "title heading present",
      (ctx) =>
        ctx.blocks.some(
          (block) =>
            block.isHeading && /Pride and Prejudice/i.test(block.text ?? "")
        ),
    ],
    [
      "opening chapter intact",
      (ctx) => {
        const chapter = ctx.blocks.find((block) =>
          /^Chapter\s+1\.?$/i.test(block.text ?? "")
        )
        return chapter?.isHeading === true
      },
    ],
    [
      "famous opening sentence present",
      (ctx) =>
        ctx.joined.includes(
          "It is a truth universally acknowledged, that a single man in possession of a good fortune"
        ),
    ],
  ],
}
