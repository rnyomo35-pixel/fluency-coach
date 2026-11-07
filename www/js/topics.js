/* ════════════════════════════════════════════════════════
   Topic bank — unpredictable, thought-provoking 10s prompts
   ════════════════════════════════════════════════════════ */

const TOPICS = [
  // ── Daily life
  "What's the most useless skill you're secretly proud of?",
  "Describe your perfect lazy Sunday from sunrise to midnight.",
  "If you could only eat one dish for the rest of your life, which and why?",
  "What's a small everyday thing that makes you irrationally happy?",
  "Would you rather have a personal chef or a personal driver?",
  "What do people misunderstand about your job or your day?",
  "Describe your hometown to a tourist who will never visit it.",
  "What's the strangest compliment you've ever received?",
  "Talk about a purchase under $20 that changed your life.",
  "What chore would you ban from existence forever?",
  "How do you actually feel about small talk?",
  "What's the best conversation you've had with a complete stranger?",

  // ── Philosophy & deep questions
  "Would you take a pill that made you never feel boredom?",
  "If your memory could be backed up like a phone, what would you delete first?",
  "What's one thing you believe that most people your age don't?",
  "Is a long, hard journey better than a quick, easy answer?",
  "Can someone be a good person and still do terrible things?",
  "If happiness was guaranteed but you had no free time, would you sign?",
  "What's something true today that will sound absurd in 100 years?",
  "Does a choice matter if the outcome was inevitable?",
  "Is talent real, or is it just curiosity that never wore out?",
  "Should people be allowed to forget their worst day?",
  "What would you tell your 10-year-old self in one sentence?",
  "Would you rather know the date of your death or the cause?",
  "Is silence a language? What can you say without words?",

  // ── Technology
  "Should AI agents be allowed to read everyone's messages to stop crime?",
  "Would you travel to space if your heart had a 10% survival risk?",
  "What app would you erase from humanity immediately?",
  "If robots do all boring jobs, what will humans complain about?",
  "Should your car be allowed to drive faster than you legally can?",
  "What would happen if the internet disappeared for exactly one year?",
  "Would you let a company scan your brain for better ads?",
  "Should children be taught coding, or logic instead?",
  "One day, your phone tells you it loves you. What do you reply?",
  "Is it okay to clone your dead pet?",
  "What technology from movies do you secretly hope never becomes real?",
  "Would you take a subscription for unlimited eternal life?",

  // ── Funny hypotheticals
  "If animals could talk, which species would be the rudest?",
  "You have to replace every smile in the world with a handshake. Chaos or peace?",
  "What if gravity took a random day off every year?",
  "If you could shrink any object to the size of a coin, what would you shrink?",
  "What's the worst possible superhero power you can imagine?",
  "If socks had feelings, how would you treat your missing one?",
  "You're an Olympic athlete in a made-up sport. What's your discipline?",
  "If your Wi-Fi had a name tag at a party, what would people say about it?",
  "Bananas or phones — which one runs the world?",
  "What would happen if your pet managed your finances for a week?",
  "If Monday were a person, would you invite it to your birthday?",

  // ── Science
  "Is it worth spending billions to search for alien life while Earth has problems?",
  "If you could cheat physics for one day, what law would you break?",
  "Should we genetically edit humans to eliminate hereditary disease?",
  "What's more amazing: a telescope seeing the past, or a microscope seeing the living?",
  "Would you upload your mind if the copy wasn't really you?",
  "Is the ocean more exciting or terrifying? Explain in 10 seconds.",
  "What scientific achievement deserves more fame than it gets?",
  "If the sun burnt out tonight, what would humanity's first week look like?",
  "Is there anything science should NOT try to explain?",
  "Would you rather drink recycled wastewater or never drink water again?",
];

/** Returns a random topic, never the same as the previous one if avoidable. */
function getRandomTopic(prevTopic) {
  let next = prevTopic;
  while (TOPICS.length > 1 && next === prevTopic) {
    next = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  }
  return next;
}
