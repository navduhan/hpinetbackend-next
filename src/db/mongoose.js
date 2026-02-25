const mongoose = require("mongoose");
const { MONGODB_URI } = require("../config/env");

mongoose.set("strictQuery", true);

function connectMongo() {
  return mongoose.connect(MONGODB_URI);
}

function useDb(name) {
  return mongoose.connection.useDb(name, { useCache: true });
}

function getOrCreateModel(db, name, schema) {
  return db.models[name] || db.model(name, schema, name);
}

module.exports = {
  mongoose,
  connectMongo,
  useDb,
  getOrCreateModel
};
