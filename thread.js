const request = require('request')
const cheerio = require('cheerio')
const rp = require('request-promise')
const Emitter = require('events')
const fs = require('fs')
const path = require('path')
const async = require('async')
const iconv = require('iconv-lite')

class Thread extends Emitter {
  constructor({url, config}) {
    super()
    this.url = url
    this.config = config
    this.emit('step', 'init')
    for (let lesson of this.config.lessonList) {
      if (lesson.status !== 'success') {
        if (typeof lesson.status !== 'object') {
          this.lesson = lesson
          lesson.status = this
        }
      }
    }
    if (!this.lesson)
      this.lesson = this.config.lessonList
        .filter(i => i.status !== 'success')
        .shift()
    this.name = Date.now() + ''
    this.request = request.defaults({
      jar: request.jar(),
      baseUrl: url,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/64.0.3269.3 Safari/537.36',
        'Referer': `${url}/default2.aspx`,
      }
    })
  }

  start() {
    this.work().catch(err => {
      this.emit('error', err)
      this.emit('down', this)
    })
    return this
  }

  async work() {
    setTimeout(() => {
      this.emit('up', this)
    })
    while (!this.logged) {
      const err = await this.login()
      if (err) this.emit('msg', err)
      else this.logged = true
    }
    this.name = await this.getInfo()
    this.emit('logged', this.name)
    await this.fetchLesson()
    this.emit('down', this)
  }

  async login() {
    this.emit('step', 'logging')
    const $ = await new Promise((resolve, reject) => {
      this.request({
        uri: `/default2.aspx`,
      }, (err, res, body) => {
        if (err) reject(err)
        else {
          resolve(cheerio.load(body))
        }
      })
    })
    const captchaName = path.join(__dirname, `${this.name}.png`)
    const code = await new Promise((resolve, reject) => {
      const res = this.request('/CheckCode.aspx')
      res.on('error', err => reject(err))
      res.pipe(fs.createWriteStream(captchaName))
        .on('close', () => {
          resolve(this.localVerifyCaptcha())
        })
    })
    if (fs.existsSync(captchaName)) fs.unlinkSync(captchaName)
    await new Promise((resolve, reject) => {
      const res = this.request.post({
        uri: `/default2.aspx`,
        form: {
          'Button1': '',
          'RadioButtonList1': iconv.encode('学生', 'gbk'),
          'TextBox2': this.config.password,
          '__EVENTVALIDATION': $('input#__EVENTVALIDATION').attr('value'),
          '__VIEWSTATE': $('input#__VIEWSTATE').attr('value'),
          'hidPdrs': '',
          'hidsc': '',
          'lbLanguage': '',
          'txtSecretCode': code,
          'txtUserName': this.config.username,
        },
        headers: {
          'Referer': `${this.url}/default2.aspx`,
        }
      })
      res.on('error', err => reject(err))
      res.pipe(iconv.decodeStream('gb2312')).collect((err, body) => {
        if (err) reject(err)
        else {
          const re = body.match(/alert\('([^']+)/i)
          if (re) resolve(re[1])
          else {
            resolve(body)
          }
        }
      })
    })
  }

  getInfo() {
    return new Promise((resolve, reject) => {
      const res = this.request({
        uri: `/xsgrxx.aspx?xh=${this.config.username}&`,
        headers: {
          'Referer': `${this.url}/xs_main.aspx?xh=${this.config.username}`,
        }
      })
      res.on('error', err => reject(err))
      res.pipe(iconv.decodeStream('gb2312'))
        .collect((err, body) => {
          if (err) reject(err)
          else {
            const $ = cheerio.load(body)
            const name = $('table.formlist tr:nth-child(2) td:nth-child(2)').text()
            resolve(name)
          }
        })
    })
  }

  async localVerifyCaptcha() {
    const text = await rp.post({
      url: 'https://www.cnwangjie.com/rc/',
      formData: {
        img: {
          value: fs.createReadStream(`${__dirname}/${this.name}.png`),
          options: {
            filename: `${this.name}.png`,
            contentType: 'image/png',
          }
        }
      }
    })
    return text.match(/{{(....)}}/)[1]
  }

  async fetchLesson() {
    this.emit('step', 'preparing')
    const $ = await new Promise((resolve, reject) => {
      const res = this.request({
        uri: this.lesson.uri,
        headers: {
          'Referer': encodeURI(`${this.url}/xsxk.aspx?xh=${this.config.username}&xm=${this.name}&gnmkdm=N121101`),
        }
      })
      res.on('error', err => reject(err))
      res.pipe(iconv.decodeStream('gb2312'))
        .collect((err, body) => {
          if (err) reject(err)
          else {
            resolve(cheerio.load(body))
          }
        })
    })

    const xkkh = $('table.formlist')
      .find('tr')
      .filter((i, e) => {
        const text = $(e).text()
        return text.indexOf(this.lesson.tech) !== -1 &&
          text.indexOf(this.lesson.time) !== -1
      })
      .first()
      .find('td')
      .eq(-1)
      .html()
      .match(/value="([^"]+)"/)[1]

    if (xkkh) this.emit('step', 'fetching')
    else throw new Error(`can not find lesson that teacher: ${this.lesson.tech} time: ${this.lesson.time}`)
    while (this.lesson.status !== 'success') {
      await new Promise((resolve, reject) => {
        setTimeout(() => resolve(), 1000)
      })
      const re = await new Promise((resolve, reject) => {
        const res = this.request.post({
          uri: this.lesson.uri,
          headers: {
            'Referer': `${this.url}${this.lesson.uri}`
          },
          form: {
            'RadioButtonList1': '1',
            '__EVENTARGUMENT': '',
            '__EVENTTARGET': 'Button1',
            '__EVENTVALIDATION': $('input#__EVENTVALIDATION').attr('value'),
            '__VIEWSTATE': $('input#__VIEWSTATE').attr('value'),
            'xkkh': xkkh,
          }
        })
        res.on('error', err => reject(err))
        res.pipe(iconv.decodeStream('gb2312'))
          .collect((err, body) => {
            if (err) reject(err)
            else {
              const re = body.match(/alert\('([^']+)/i)
              if (re) {
                if (re[1] === '保存成功！') {
                  this.lesson.status = 'success'
                }
                resolve(re[1])
              }
            }
          })
      })

      this.emit('msg', re)
    }
  }
}

module.exports = Thread
