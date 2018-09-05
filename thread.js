const request = require('request')
const cheerio = require('cheerio')
const rp = require('request-promise')
const Emitter = require('events')
const iconv = require('iconv-lite')

const sleep = time => new Promise(r => setTimeout(r, time))

const buildFormBody = form => {
  const encodeBuffer = buf => {
    const hex = buf.toString('hex')
    let r = ''
    for (let i = 0; i < hex.length; i += 2) {
      r += '%' + hex.substr(i, 2).toUpperCase()
    }
    return r
  }
  return Object.entries(form).map(([k, v]) => {
    return k + '=' + (typeof v === 'string' ? encodeURIComponent(v) : encodeBuffer(v))
  }).join('&')
}

class Thread extends Emitter {
  constructor({url, config}) {
    super()
    this.url = url
    this.config = config
    this.fetchInterval = config.fetchInterval || 5000
    this.loginMaxRetryTimes = config.loginMaxRetryTimes || 3
    for (let lesson of this.config.lessonList) {
      if (lesson.status !== 'success') {
        if (typeof lesson.status !== 'object') {
          this.lesson = lesson
          lesson.status = this
        }
      }
    }
    if (!this.lesson) {
      this.lesson = this.config.lessonList
        .filter(i => i.status !== 'success')
        .shift()
    }
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
    let loginTried = 0
    while (!this.logged) {
      loginTried += 1
      const re = await this.login()
      if (re.err) {
        this.emit('msg', re.err)
        await sleep(this.fetchInterval)
        if (loginTried > this.loginMaxRetryTimes) {
          this.emit('error', 'login timeout')
          this.end()
          return
        }
      } else this.logged = true
    }
    this.name = await this.getInfo()
    this.emit('logged', this.name)
    this.emit('msg', 'name: ' + this.name)
    if (this.lesson.uri) await this.fetchLesson()
    else if (this.lesson.ty) await this.fetchPE()
    this.emit('down', this)
  }

  async login() {
    this.emit('step', 'logging')
    const $ = await new Promise((resolve, reject) => {
      this.request({
        uri: `/default2.aspx`,
      }, (err, res, body) => {
        if (err) reject(err)
        resolve(cheerio.load(body))
      })
    })
    const code = await new Promise((resolve, reject) => {
      this.request('/CheckCode.aspx', {encoding: null}, (err, res, body) => {
        if (err) reject(err)
        const bodyEnd = body.indexOf('<!DOCTYPE')
        if (~bodyEnd) {
          body = body.slice(0, bodyEnd)
        }
        this.imgBuf = body
        resolve(this.localVerifyCaptcha(body))
      })
    })
    return new Promise((resolve, reject) => {
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
        const re = body.match(/alert\('([^']+)/i)
        if (re) resolve({err: re[1]})
        else if (body.indexOf('Object moved') !== -1) resolve({err: null, body: 'Object moved'})
        else resolve({err: null, body})
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
      res.pipe(iconv.decodeStream('gb2312')).collect((err, body) => {
          if (err) reject(err)
          const $ = cheerio.load(body)
          const name = $('table.formlist tr:nth-child(2) td:nth-child(2)').text()
          resolve(name)
        })
    })
  }

  async localVerifyCaptcha(imgBuf) {
    const text = await rp.post({
      url: 'https://www.cnwangjie.com/rc/',
      formData: {
        img: {
          value: imgBuf,
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
      res.pipe(iconv.decodeStream('gb2312')).collect((err, body) => {
          if (err) reject(err)
          resolve(cheerio.load(body))
        })
    })

    let xkkh
    try {
      xkkh = $('table.formlist')
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
    } finally {
      if (xkkh) this.emit('step', 'fetching')
      else throw new Error(`can not find lesson that teacher: ${this.lesson.tech} time: ${this.lesson.time}`)
    }

    while (this.lesson.status !== 'success') {
      await sleep(this.fetchInterval)
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
        res.pipe(iconv.decodeStream('gb2312')).collect((err, body) => {
          if (err) reject(err)
          const re = body.match(/alert\('([^']+)/i)
          if (!re) reject(body)
          if (re[1] === '请先选择教师！') reject('请先选择教师！')
          if (re[1] === '保存成功！') {
            if (this.config.notice) rp(this.config.notice)
            this.lesson.status = 'success'
          }
          resolve(re[1])
        })
      })

      this.emit('msg', re)
    }
  }

  async fetchPE() {
    this.emit('step', 'preparing')

    const $ = await new Promise((resolve, reject) => {
      const res = this.request({
        uri: `/xstyk.aspx?xh=${this.config.username}`,
        headers: {
          'Referer': encodeURI(`${this.url}/xsxk.aspx?xh=${this.config.username}&xm=${this.name}&gnmkdm=N121101`),
        },
      })
      res.on('error', err => reject(err))
      res.pipe(iconv.decodeStream('gb2312')).collect((err, body) => {
        if (err) reject(err)
        resolve(cheerio.load(body))
      })
    })

    await sleep(2000)

    const $t = await new Promise((resolve, reject) => {
      const form = {
        '__EVENTTARGET': 'ListBox1',
        '__EVENTARGUMENT': '',
        '__LASTFOCUS': '',
        '__VIEWSTATE': $('input#__VIEWSTATE').attr('value'),
        'DropDownList1': iconv.encode('项目', 'gbk'),
        'ListBox1': this.lesson.ty,
        '__EVENTVALIDATION': $('input#__EVENTVALIDATION').attr('value'),
      }
      const res = this.request.post({
        uri: `/xstyk.aspx?xh=${this.config.username}`,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
          'Origin': this.url,
          'Referer': encodeURI(`${this.url}/xstyk.aspx?xh=${this.config.username}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: buildFormBody(form),
      })
      res.on('error', err => reject(err))
      res.pipe(iconv.decodeStream('gb2312')).collect((err, body) => {
        if (err) reject(err)
        resolve(cheerio.load(body))
      })
    })

    const listbox2 = $t('option')
      .filter((i, e) => {
        const text = $(e).text()
        return text.indexOf(this.lesson.tech) !== -1 &&
          text.indexOf(this.lesson.time) !== -1
      })
      .first()
      .attr('value')

    if (listbox2) this.emit('step', 'fetching')
    else throw new Error(`can not find lesson that teacher: ${this.lesson.tech} time: ${this.lesson.time}`)
    while (this.lesson.status !== 'success') {
      await sleep(this.fetchInterval)
      const form = {
        '__EVENTTARGET': '',
        '__EVENTARGUMENT': '',
        '__LASTFOCUS': '',
        '__VIEWSTATE': $t('input#__VIEWSTATE').attr('value'),
        'DropDownList1': iconv.encode('项目', 'gb2312'),
        'ListBox1': this.lesson.ty,
        'ListBox2': listbox2,
        'RadioButtonList1': '0',
        'button3': iconv.encode('选定课程', 'gb2312'),
        '__EVENTVALIDATION': $t('input#__EVENTVALIDATION').attr('value'),
      }
      const body = buildFormBody(form)
      const re = await new Promise((resolve, reject) => {
        const res = this.request.post({
          uri: `/xstyk.aspx?xh=${this.config.username}`,
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            'Origin': this.url,
            'Referer': encodeURI(`${this.url}/xstyk.aspx?xh=${this.config.username}`),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        })
        res.on('error', err => reject(err))
        res.pipe(iconv.decodeStream('gb2312')).collect((err, body) => {
          if (err) reject(err)
          const re = body.match(/alert\('([^']+)/i)
          if (!re) reject(body)
          if (re[1] === '请先选择教师！') reject('请先选择教师！')
          if (re[1] === '保存成功！') {
            if (this.config.notice) rp(this.config.notice)
            this.lesson.status = 'success'
          }
          resolve(re[1])
        })
      })
      this.emit('msg', re)
    }

  }
}

module.exports = Thread
