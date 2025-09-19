function timestamp() {
  return new Date().toISOString();
}

function format(scope, message) {
  return `[${timestamp()}] [${scope}] ${message}`;
}

module.exports = {
  info(scope, message) {
    console.log(format(scope, message));
  },
  warn(scope, message) {
    console.warn(format(scope, message));
  },
  error(scope, message, error) {
    if (error) {
      console.error(format(scope, `${message}: ${error.message}`));
      if (error.stack) {
        console.error(error.stack);
      }
    } else {
      console.error(format(scope, message));
    }
  },
  debug(scope, message) {
    if (process.env.NODE_ENV === 'development') {
      console.debug(format(scope, message));
    }
  },
};
