import db from "./db";

class TopicDisplayNameManager {
  async get(topic) {
    const record = await db().topicDisplayNames.get(topic);
    return record?.displayName || "";
  }

  async set(topic, displayName) {
    if (displayName) {
      await db().topicDisplayNames.put({ topic, displayName });
    } else {
      await db().topicDisplayNames.delete(topic);
    }
  }

  async getAll() {
    const records = await db().topicDisplayNames.toArray();
    const map = {};
    for (const record of records) {
      map[record.topic] = record.displayName;
    }
    return map;
  }
}

export default new TopicDisplayNameManager();
