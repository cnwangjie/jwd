const fs = require('fs')
const yaml = require('js-yaml')
const chalk = require('chalk')
const Thread = require('./thread.js')

const config = {}

try {
  Object.assign(config, yaml.safeLoad(fs.readFileSync('config.yml', 'utf8')))
} catch (e) {
  console.log(chalk.red('load config file failed'))
  process.exit(1)
}

const startNewThread = ({url, config}) => {
  const thread = new Thread({url, config}).start()
  let threadname
  thread.once('up', () => {
    threadname = thread.name + ' ' + thread.url
    console.log(chalk.white(`${threadname} up`))
  })
  thread.once('down', () => {
    thread.removeAllListeners()
    console.log(chalk.white(`${threadname} down`))
    if (config.lessonList.filter(i => i.status !== 'success').length !== 0) {
      setTimeout(() => startNewThread({url, config}), 5000)
    } else {
      console.log(chalk.green(`done!`))
      process.exit(0)
    }
  })
  thread.on('step', step => {
    console.log(chalk.green(`${threadname} ${step}`))
  })
  thread.on('msg', msg => {
    console.log(`${threadname} ${msg}`)
  })
  thread.on('error', error => {
    console.log(chalk.red(`${threadname} ${error}`))
  })
}

const main = () => {
  const urlList = config.urlList
  for (let url of urlList) {
    startNewThread({url, config})
  }
}

main()
