// booster.mjs - Core Chaoxing Plaza Chapter Quiz Points Booster
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, connectViaProfile, sleep } from './chrome-launcher.mjs';

const QUIZ_DOC_FN = `
function findQuizDoc() {
  let doc = document.querySelector('#iframe')?.contentDocument?.querySelector('iframe')?.contentDocument?.querySelector('#frame_content')?.contentDocument;
  if (doc && (doc.querySelector('.singleQuesId') || doc.body?.innerText.includes('待完成'))) return doc;
  const search = (d) => {
    if (!d) return null;
    if (d.querySelector && (d.querySelector('.singleQuesId') || /待完成/.test(d.body?.innerText || ''))) return d;
    const iframes = d.querySelectorAll ? d.querySelectorAll('iframe') : [];
    for (const f of iframes) {
      try {
        const sub = search(f.contentDocument);
        if (sub) return sub;
      } catch {}
    }
    return null;
  };
  return search(document);
}
`;

export class QuizBooster {
  constructor(stateDir = './state', targetScore = 800) {
    this.stateDir = resolve(stateDir);
    this.targetScore = targetScore;
    this.cdp = null;
    this.session = null;
  }

  async loadSession() {
    try {
      const data = await readFile(join(this.stateDir, 'session.json'), 'utf8');
      this.session = JSON.parse(data);
    } catch {
      this.session = {};
    }
    return this.session;
  }

  async saveSession(extra = {}) {
    this.session = { ...(this.session || {}), ...extra, updatedAt: new Date().toISOString() };
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(join(this.stateDir, 'session.json'), JSON.stringify(this.session, null, 2));
    return this.session;
  }

  async connect() {
    await this.loadSession();
    try {
      this.cdp = await connectViaProfile(this.stateDir);
      return this.cdp;
    } catch {
      throw new Error(`Cannot connect to Chrome in ${this.stateDir}. Did you run 'booster.mjs init --url <URL>' first?`);
    }
  }

  async getTabs() {
    const pages = await this.cdp.targets();
    const plaza = pages.find(p => p.url.includes('/plaza/'));
    const study = pages.find(p => p.url.includes('/mycourse/') || p.url.includes('/nodedetailcontroller/'));
    return { pages, plaza, study };
  }

  async getScore(plazaTargetId) {
    if (!plazaTargetId) {
      const { plaza } = await this.getTabs();
      if (!plaza) throw new Error('Plaza tab not found');
      plazaTargetId = plaza.targetId;
    }
    // Reload plaza page to ensure freshest points
    await this.cdp.evaluate(plazaTargetId, 'location.reload()');
    await sleep(2500);

    const scoreInfo = await this.cdp.evaluate(plazaTargetId, `(()=>{
      const text = document.body.innerText;
      const totalM = text.match(/(\\d+)\\s*累计积分/);
      const todayM = text.match(/(\\d+)\\s*今日积分/);
      const daysM = text.match(/(\\d+)\\s*累计天数/);
      return {
        total: totalM ? Number(totalM[1]) : null,
        today: todayM ? Number(todayM[1]) : null,
        days: daysM ? Number(daysM[1]) : null,
        title: document.title
      };
    })()`);
    return scoreInfo;
  }

  async init(url, chromePath = null) {
    await mkdir(this.stateDir, { recursive: true });
    const { cdp, targetId, stateDir } = await launchChrome({
      stateDir: this.stateDir,
      url,
      chromePath
    });
    this.cdp = cdp;

    // Check if user is logged in
    await sleep(2000);
    const pages = await cdp.targets();
    const plazaTab = pages.find(p => p.url.includes('/plaza/')) || pages.find(p => p.targetId === targetId);

    if (!plazaTab || !plazaTab.url.includes('/plaza/')) {
      await this.saveSession({ initialUrl: url, targetScore: this.targetScore });
      return {
        status: 'WAITING_FOR_LOGIN',
        message: '请在打开的 Chrome 窗口中完成超星账号登录，并进入课程学习广场页面。登录完成后请再次执行 init。',
        currentUrl: plazaTab?.url || url
      };
    }

    // Extract course metadata from plaza tab
    const meta = await cdp.evaluate(plazaTab.targetId, `(()=>{
      const u = new URL(location.href);
      return {
        url: location.href,
        courseId: u.searchParams.get('courseId'),
        classId: u.searchParams.get('classId'),
        personId: u.searchParams.get('personId'),
        userId: u.searchParams.get('userId'),
        title: document.title
      };
    })()`);

    const score = await this.getScore(plazaTab.targetId);

    await this.saveSession({
      plazaTargetId: plazaTab.targetId,
      plazaUrl: meta.url,
      courseId: meta.courseId,
      classId: meta.classId,
      personId: meta.personId,
      userId: meta.userId,
      targetScore: this.targetScore
    });

    return {
      status: 'READY',
      course: meta,
      score,
      targetScore: this.targetScore
    };
  }

  async ensureSingleStudyTab() {
    const { pages, plaza } = await this.getTabs();
    if (!plaza) throw new Error('Plaza tab not found');

    const studyTabs = pages.filter(p => p.url.includes('/mycourse/') || p.url.includes('/nodedetailcontroller/'));

    // Enforce SINGLE study tab policy: close duplicates
    if (studyTabs.length > 1) {
      for (let i = 1; i < studyTabs.length; i++) {
        await this.cdp.closeTarget(studyTabs[i].targetId);
      }
    }

    if (studyTabs.length >= 1) {
      return studyTabs[0].targetId;
    }

    // Open first study tab from plaza
    const opened = await this.cdp.evaluate(plaza.targetId, `(()=>{
      const firstA = [...document.querySelectorAll('a')].find(a => a.href && a.href.includes('goKnowledge'));
      if (firstA) { firstA.click(); return 'clicked goKnowledge'; }
      const anyKnowledge = [...document.querySelectorAll('a')].find(a => a.href && a.href.includes('knowledgeId='));
      if (anyKnowledge) { anyKnowledge.click(); return 'clicked knowledge'; }
      return null;
    })()`);

    // Wait for the study tab to appear
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const updated = await this.cdp.targets();
      const s = updated.find(p => p.url.includes('/mycourse/') || p.url.includes('/nodedetailcontroller/'));
      if (s) {
        await this.saveSession({ studyTargetId: s.targetId });
        return s.targetId;
      }
    }
    throw new Error('Failed to open study tab from plaza');
  }

  async nextQuiz() {
    const studyTargetId = await this.ensureSingleStudyTab();

    // Loop until we find a chapter with an incomplete assessment
    for (let attempt = 0; attempt < 50; attempt++) {
      // 1. Wait for chapter header
      for (let i = 0; i < 20; i++) {
        const hasHeader = await this.cdp.evaluate(studyTargetId, `Boolean(document.querySelector('#mainid'))`);
        if (hasHeader) break;
        await sleep(300);
      }

      // 2. Check if this chapter has an assessment tab
      const tabInfo = await this.cdp.evaluate(studyTargetId, `(()=>{
        const tabs = [...document.querySelectorAll('#mainid [id^=dct]')];
        const quizTab = tabs.find(e => /知识测[评验]|章节测验/.test(e.innerText));
        if (quizTab) {
          quizTab.click();
          return { found: true, id: quizTab.id, label: quizTab.innerText.trim() };
        }
        return { found: false };
      })()`);

      if (tabInfo.found) {
        await sleep(2000);
        // Check quiz iframe
        const quizStatus = await this.cdp.evaluate(studyTargetId, `(()=>{
          ${QUIZ_DOC_FN}
          const d = findQuizDoc();
          if (!d) return { loaded: false };
          const text = d.body ? d.body.innerText : '';
          const incomplete = /待完成/.test(text);
          const completed = /已完成|本次成绩/.test(text);
          const qs = [...d.querySelectorAll('.singleQuesId')];
          return {
            loaded: true,
            incomplete,
            completed,
            questionCount: qs.length,
            title: document.querySelector('#mainid')?.innerText.split('\\n')[0] || document.title,
            chapterId: new URL(location.href).searchParams.get('chapterId')
          };
        })()`);

        if (quizStatus.loaded && quizStatus.incomplete && quizStatus.questionCount > 0) {
          // Take screenshot of quiz for agent inspection
          const screenshotPath = join(this.stateDir, 'current-quiz.png');
          await this.cdp.screenshot(studyTargetId, screenshotPath);

          // Get detailed question structure
          const questions = await this.cdp.evaluate(studyTargetId, `(()=>{
            ${QUIZ_DOC_FN}
            const d = findQuizDoc();
            const qs = [...d.querySelectorAll('.singleQuesId')];
            return qs.map((q, idx) => {
              const opts = [...q.querySelectorAll('li[role=radio], li[role=checkbox]')];
              const isRadio = q.querySelector('li[role=radio]') !== null;
              return {
                index: idx,
                type: isRadio ? (opts.length === 2 ? '判断题' : '单选题') : '多选题',
                optionCount: opts.length
              };
            });
          })()`);

          return {
            status: 'QUIZ_READY',
            chapterId: quizStatus.chapterId,
            title: quizStatus.title,
            questionCount: quizStatus.questionCount,
            questions,
            screenshot: screenshotPath
          };
        }
      }

      // No incomplete quiz on this chapter, advance to next chapter
      const advanced = await this.advanceChapter(studyTargetId);
      if (!advanced) {
        return { status: 'NO_MORE_CHAPTERS', message: 'All chapters scanned or reach end of course.' };
      }
      await sleep(1500);
    }

    return { status: 'TIMEOUT', message: 'Exceeded maximum chapter scanning attempts' };
  }

  async advanceChapter(studyTargetId) {
    return this.cdp.evaluate(studyTargetId, `(()=>{
      const nextBtn = document.getElementById('prevNextFocusNext');
      if (nextBtn) { nextBtn.click(); return true; }
      const tipPopup = document.getElementById('jobFinishTipFocus')?.parentElement;
      const offeredA = tipPopup ? [...tipPopup.querySelectorAll('a')].find(e => e.innerText.trim() === '下一节') : null;
      if (offeredA) { offeredA.click(); return true; }
      return false;
    })()`);
  }

  async submitQuiz(answers) {
    const studyTargetId = await this.ensureSingleStudyTab();
    const ansArray = Array.isArray(answers) ? answers : JSON.parse(answers);

    // 1. Fill answers in iframe
    const fillResult = await this.cdp.evaluate(studyTargetId, `(()=>{
      ${QUIZ_DOC_FN}
      const d = findQuizDoc();
      if (!d) throw new Error('Quiz iframe document not found');
      if (!/待完成/.test(d.body.innerText)) throw new Error('Quiz is not in incomplete status');

      const qs = [...d.querySelectorAll('.singleQuesId')];
      const answers = ${JSON.stringify(ansArray)};
      if (qs.length !== answers.length) {
        throw new Error('Question count mismatch: expected ' + answers.length + ', got ' + qs.length);
      }

      for (let i = 0; i < qs.length; i++) {
        const opts = [...qs[i].querySelectorAll('li[role=radio], li[role=checkbox]')];
        const selection = Array.isArray(answers[i]) ? answers[i] : [answers[i]];
        for (const idx of selection) {
          const opt = opts[idx];
          if (!opt) throw new Error('Question ' + (i+1) + ' missing option ' + idx);
          opt.click();
        }
      }

      // Click submit
      const submitBtn = [...d.querySelectorAll('[role=button], button, a')].find(e => e.innerText.trim() === '提交');
      if (!submitBtn) throw new Error('Submit button not found');
      submitBtn.click();
      return 'submitted';
    })()`);

    // 2. Click confirm popup (#popok)
    let confirmed = false;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      confirmed = await this.cdp.evaluate(studyTargetId, `(()=>{
        const okBtn = document.getElementById('popok');
        if (okBtn && document.body.innerText.includes('确认提交')) {
          okBtn.click();
          return true;
        }
        return false;
      })()`);
      if (confirmed) break;
    }
    if (!confirmed) throw new Error('Confirm submit popup did not appear');

    // 3. Wait for result & grade recording
    let grade = null;
    let chapterId = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const res = await this.cdp.evaluate(studyTargetId, `(()=>{
        ${QUIZ_DOC_FN}
        const d = findQuizDoc();
        const text = d?.body?.innerText || '';
        if (text.includes('本次成绩') || text.includes('已完成')) {
          const scoreMatch = text.match(/本次成绩(\\d+分)/);
          return {
            recorded: true,
            score: scoreMatch ? scoreMatch[1] : '已完成',
            chapterId: new URL(location.href).searchParams.get('chapterId'),
            text: text.slice(0, 300)
          };
        }
        return { recorded: false };
      })()`);

      if (res.recorded) {
        grade = res.score;
        chapterId = res.chapterId;
        await appendFile(
          join(this.stateDir, 'quiz-history.jsonl'),
          JSON.stringify({ time: new Date().toISOString(), chapterId, grade, answers: ansArray }) + '\n'
        );
        break;
      }
    }

    return {
      success: true,
      grade: grade || 'Recorded',
      chapterId
    };
  }

  async step(answers) {
    // 1. Submit current quiz
    const subResult = await this.submitQuiz(answers);
    await sleep(1500);

    // 2. Check plaza score
    const score = await this.getScore(this.session?.plazaTargetId);

    // 3. Check if target reached
    if (score.total !== null && score.total >= this.targetScore) {
      await this.finish();
      return {
        status: 'TARGET_REACHED',
        finalScore: score.total,
        todayScore: score.today,
        confirmationScreenshot: join(this.stateDir, 'score-confirmation.png')
      };
    }

    // 4. Advance to next quiz
    const { study } = await this.getTabs();
    if (study) {
      await this.advanceChapter(study.targetId);
      await sleep(1500);
    }

    const next = await this.nextQuiz();
    return {
      status: next.status,
      currentScore: score.total,
      todayScore: score.today,
      remainingPoints: Math.max(0, this.targetScore - (score.total || 0)),
      nextQuiz: next
    };
  }

  async finish() {
    const { plaza, study } = await this.getTabs();
    const screenshotPath = join(this.stateDir, 'score-confirmation.png');

    if (plaza) {
      await this.cdp.screenshot(plaza.targetId, screenshotPath);
    }
    // Cleanly close study tab
    if (study) {
      await this.cdp.closeTarget(study.targetId);
    }
    return {
      success: true,
      screenshot: screenshotPath
    };
  }
}

// CLI Handling
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'help';

  const getOpt = (flag, def = null) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
  };

  const stateDir = getOpt('--state-dir', './state');
  const targetScore = Number(getOpt('--target', '800'));
  const booster = new QuizBooster(stateDir, targetScore);

  try {
    if (cmd === 'init') {
      const url = getOpt('--url');
      if (!url) throw new Error('--url <PLAZA_URL> is required for init');
      const res = await booster.init(url, getOpt('--chrome'));
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === 'status') {
      await booster.connect();
      const score = await booster.getScore();
      console.log(JSON.stringify({
        score,
        target: targetScore,
        reached: (score.total || 0) >= targetScore
      }, null, 2));
    } else if (cmd === 'next-quiz') {
      await booster.connect();
      const res = await booster.nextQuiz();
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === 'submit') {
      const ansArg = args[1];
      if (!ansArg) throw new Error('Answer JSON required: submit "[1, 0, 2]"');
      await booster.connect();
      const res = await booster.submitQuiz(ansArg);
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === 'step') {
      const ansArg = args[1];
      if (!ansArg) throw new Error('Answer JSON required: step "[1, 0, 2]"');
      await booster.connect();
      const res = await booster.step(ansArg);
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === 'finish') {
      await booster.connect();
      const res = await booster.finish();
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log('Commands:');
      console.log('  init --url <PLAZA_URL> [--state-dir ./state] [--target 800]');
      console.log('  status [--state-dir ./state]');
      console.log('  next-quiz [--state-dir ./state]');
      console.log('  submit "<answers_json>" [--state-dir ./state]');
      console.log('  step "<answers_json>" [--state-dir ./state]');
      console.log('  finish [--state-dir ./state]');
    }
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }, null, 2));
    process.exit(1);
  } finally {
    if (booster.cdp) booster.cdp.close();
  }
}
