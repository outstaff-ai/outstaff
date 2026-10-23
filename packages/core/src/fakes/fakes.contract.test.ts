import {
  avatarsContract,
  chatContract,
  knowledgeContract,
  runtimeContract,
  trackerContract,
  vcsContract,
} from "../contracts/index.js";
import {
  createFakeAvatars,
  createFakeChat,
  createFakeKnowledge,
  createFakeRuntime,
  createFakeTracker,
  createFakeVcs,
} from "./index.js";

trackerContract("fake", async () => {
  const subject = createFakeTracker();
  return { subject, seed: subject.seed, capabilities: ["tracker.issues", "tracker.assign"] };
});

knowledgeContract("fake", async () => {
  const subject = createFakeKnowledge();
  return { subject, seed: subject.seed, capabilities: ["knowledge.docs"] };
});

vcsContract("fake", async () => {
  const subject = createFakeVcs();
  return { subject, seed: subject.seed, capabilities: ["vcs.pullRequests", "vcs.reviewThreads"] };
});

chatContract("fake", async () => {
  const subject = createFakeChat();
  return {
    subject,
    seed: subject.seed,
    capabilities: ["chat.messages", "chat.history", "chat.agentProfile"],
  };
});

runtimeContract("fake", async () => {
  const subject = createFakeRuntime();
  return { subject, seed: subject.seed, capabilities: ["runtime.sessions", "runtime.usage"] };
});

avatarsContract("fake", async () => ({
  subject: createFakeAvatars(),
  seed: {},
  capabilities: ["avatars.generate"],
}));
