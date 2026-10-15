// booster.mjs - Core Chaoxing Plaza Chapter Quiz Points Booster
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, connectViaProfile, sleep } from './chrome-launcher.mjs';
import { CDPProxyClient } from './cdp-client.mjs';

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
    if (await CDPProxyClient.isAvailable()) {
      this.cdp = new CDPProxyClient();
      return this.cdp;
    }
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

  async getScore(plazaTargetId, previousScore = null) {
    if (!plazaTargetId) {
      const { plaza } = await this.getTabs();
      if (!plaza) throw new Error('Plaza tab not found');
      plazaTargetId = plaza.targetId;
    }

    const read = async () => {
      try {
        await this.cdp.evaluate(plazaTargetId, 'location.reload()');
      } catch {}
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
      return scoreInfo || { total: null, today: null, days: null };
    };

    let res = await read();
    // If previousScore was provided and score hasn't refreshed on plaza, retry once after short delay
    if (previousScore !== null && res.total !== null && res.total <= previousScore) {
      await sleep(2000);
      res = await read();
    }
    return res;
  }


  async init(url, chromePath = null, courseKeyword = null) {
    await mkdir(this.stateDir, { recursive: true });

    let cdp, targetId;
    if (await CDPProxyClient.isAvailable()) {
      cdp = new CDPProxyClient();
      const targets = await cdp.targets();
      let target = targets.find(p => p.url.includes('/plaza/')) || targets.find(p => p.url.includes(url));
      if (!target) {
        const tid = await cdp.createTarget(url);
        target = { targetId: tid, url };
      }
      targetId = target.targetId;
    } else {
      const res = await launchChrome({
        stateDir: this.stateDir,
        url,
        chromePath
      });
      cdp = res.cdp;
      targetId = res.targetId;
    }
    this.cdp = cdp;

    // Check if user is logged in
    await sleep(2000);
    const pages = await cdp.targets();
    let plazaTab = pages.find(p => p.url.includes('/plaza/')) || pages.find(p => p.targetId === targetId);

    // If not on plaza yet, wait up to 120s for user to log in and enter plaza
    if (!plazaTab || !plazaTab.url.includes('/plaza/')) {
      process.stdout.write('【提示】检测到尚未进入学习广场。请在已弹出的 Chrome 窗口中扫码/手机号登录...\n');
      let multiCourseNotified = false;

      for (let i = 0; i < 60; i++) {
        await sleep(2000);
        const updatedPages = await cdp.targets();
        let found = updatedPages.find(p => p.url.includes('/plaza/'));

        if (!found) {
          // If user logged in and is on course list, check available courses
          for (const p of updatedPages) {
            if (p.url.includes('tsjy.chaoxing.com') && !p.url.includes('/plaza/')) {
              try {
                const courses = await cdp.evaluate(p.targetId, `(()=>{
                  const links = Array.from(document.querySelectorAll('a[href*="/plaza/"], a[href*="courseId"], .course-item, .course_item'));
                  const items = [];
                  const seen = new Set();
                  for (const el of links) {
                    const a = el.tagName === 'A' ? el : el.querySelector('a');
                    const text = (el.innerText || '').trim();
                    if (a && a.href && text && !seen.has(text)) {
                      seen.add(text);
                      items.push({ title: text.split('\\n')[0].trim(), href: a.href });
                    }
                  }
                  return items;
                })()`);

                if (courses && courses.length > 0) {
                  if (courseKeyword) {
                    const matched = courses.find(c => c.title.includes(courseKeyword));
                    if (matched) {
                      process.stdout.write(`【自动匹配】检测到与 "${courseKeyword}" 匹配的课程《${matched.title}》，正在自动进入...\n`);
                      await cdp.evaluate(p.targetId, `(()=>{
                        const target = ${JSON.stringify(matched.title)};
                        const allA = Array.from(document.querySelectorAll('a'));
                        const targetA = allA.find(a => (a.innerText || a.parentElement?.innerText || '').includes(target));
                        if (targetA) targetA.click();
                      })()`);
                      break;
                    }
                  } else if (courses.length === 1) {
                    // Only 1 course, auto-click into plaza
                    await cdp.evaluate(p.targetId, `(()=>{
                      const a = document.querySelector('a[href*="/plaza/"], .course-item a, .course_item a');
                      if (a) a.click();
                    })()`);
                    break;
                  } else if (!multiCourseNotified) {
                    multiCourseNotified = true;
                    process.stdout.write(
                      `【检测到多门通识课】\n` +
                      courses.map((c, idx) => `  ${idx + 1}. ${c.title}`).join('\n') +
                      `\n👉 请在弹出的 Chrome 窗口中直接点击您想刷的那门课，或使用 --course <关键词> 自动匹配！\n`
                    );
                  }
                }
              } catch {}
            }
          }
        }

        found = updatedPages.find(p => p.url.includes('/plaza/'));
        if (found) {
          plazaTab = found;
          break;
        }
      }
    }

    if (!plazaTab || !plazaTab.url.includes('/plaza/')) {
      await this.saveSession({ initialUrl: url, targetScore: this.targetScore });
      return {
        status: 'WAITING_FOR_LOGIN',
        message: '等待登录超时。请在已打开的 Chrome 窗口中完成超星账号登录并进入课程学习广场，然后再次执行 init。',
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
    const categories = await this.getCourseCategories(plazaTab.targetId);

    await this.saveSession({
      plazaTargetId: plazaTab.targetId,
      plazaUrl: meta.url,
      courseId: meta.courseId,
      classId: meta.classId,
      personId: meta.personId,
      userId: meta.userId,
      categories,
      currentCategoryIndex: 0,
      visitedChapters: [],
      targetScore: this.targetScore
    });

    return {
      status: 'READY',
      course: meta,
      score,
      categoriesCount: categories.length,
      categories: categories.map(c => c.title),
      targetScore: this.targetScore
    };
  }

  async getCourseCategories(plazaTargetId) {
    if (!plazaTargetId) {
      const { plaza } = await this.getTabs();
      if (!plaza) throw new Error('Plaza tab not found');
      plazaTargetId = plaza.targetId;
    }

    const categories = await this.cdp.evaluate(plazaTargetId, `(async () => {
      // 1. Try classify-list
      try {
        const html = await fetch('/plaza/classify-list' + location.search).then(r => r.text());
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const catLinks = Array.from(doc.querySelectorAll('a[href*="classifyId="]'));
        const cats = [];
        const seen = new Set();
        for (const a of catLinks) {
          const u = new URL(a.href);
          const cid = u.searchParams.get('classifyId');
          if (cid && !seen.has(cid)) {
            seen.add(cid);
            cats.push({ classifyId: cid, title: a.innerText.trim() || cid });
          }
        }
        if (cats.length > 0) return cats;
      } catch {}

      // 2. Fallback: categories directly on plaza homepage
      const homeLinks = Array.from(document.querySelectorAll('a[href*="classifyId="]'));
      const cats = [];
      const seen = new Set();
      for (const a of homeLinks) {
        const u = new URL(a.href);
        const cid = u.searchParams.get('classifyId');
        if (cid && !seen.has(cid)) {
          seen.add(cid);
          cats.push({ classifyId: cid, title: a.innerText.trim() || cid });
        }
      }
      return cats;
    })()`);

    return (categories && categories.length > 0) ? categories : [{ classifyId: null, title: '默认课程' }];
  }

  async getCategoryKnowledgeList(classifyId, plazaTargetId) {
    if (!plazaTargetId) {
      const { plaza } = await this.getTabs();
      if (!plaza) throw new Error('Plaza tab not found');
      plazaTargetId = plaza.targetId;
    }

    return this.cdp.evaluate(plazaTargetId, `(async () => {
      if (!${JSON.stringify(classifyId)}) {
        const matches = [...document.body.innerHTML.matchAll(/goKnowledge\\(\\s*\\d+\\s*,\\s*(\\d+)/g)].map(m => m[1]);
        return [...new Set(matches)];
      }

      try {
        const param = new URLSearchParams({
          classifyId: ${JSON.stringify(classifyId)},
          element: '0',
          point: '0',
          name: '',
          page: '1',
          pageSize: '200'
        });
        const html = await fetch('/plaza/knowledge-list' + location.search + '&' + param.toString()).then(r => r.text());
        const matches = [...html.matchAll(/goKnowledge\\(\\s*\\d+\\s*,\\s*(\\d+)/g)].map(m => m[1]);
        return [...new Set(matches)];
      } catch {
        return [];
      }
    })()`);
  }

  async openStudyChapter(knowledgeId) {
    const { plaza } = await this.getTabs();
    if (!plaza) throw new Error('Plaza tab not found');
    const session = await this.loadSession();
    const courseId = session.courseId;
    const classId = session.classId;

    // 1. Get transfer URL via plaza session
    const transferUrl = await this.cdp.evaluate(plaza.targetId, `(async () => {
      try {
        const u = new URL(location.href);
        const cId = u.searchParams.get('courseId') || ${JSON.stringify(courseId)};
        const clId = u.searchParams.get('classId') || ${JSON.stringify(classId)};
        const res = await fetch('/plaza/user/' + cId + '/' + ${JSON.stringify(knowledgeId)} + '/modify-node?classId=' + clId).then(r => r.json());
        if (res && res.data) {
          const d = res.data;
          if (d.mode === 'preview') {
            return d.domain + '/nodedetailcontroller/visitnodedetail?knowledgeId=' + ${JSON.stringify(knowledgeId)} + '&courseId=' + cId;
          }
          const nodeUrl = d.domain + '/mycourse/studentstudy?chapterId=' + ${JSON.stringify(knowledgeId)} + '&courseId=' + cId + '&clazzid=' + d.classId + '&enc=' + d.enc + '&mooc2=1';
          return d.domain + '/mycourse/transfer?moocId=' + cId + '&ut=s&clazzid=' + clId + '&refer=' + encodeURIComponent(nodeUrl);
        }
      } catch {}
      return 'https://mooc1-1.chaoxing.com/nodedetailcontroller/visitnodedetail?knowledgeId=' + ${JSON.stringify(knowledgeId)} + '&courseId=' + ${JSON.stringify(courseId)};
    })()`);

    if (!transferUrl) {
      throw new Error('Failed to obtain transfer URL for chapter ' + knowledgeId);
    }

    // 2. Reuse existing study tab or create a new one
    const { pages, study } = await this.getTabs();
    let studyTargetId;

    if (study) {
      studyTargetId = study.targetId;
      await this.cdp.evaluate(studyTargetId, 'location.href = ' + JSON.stringify(transferUrl));
    } else {
      studyTargetId = await this.cdp.createTarget(transferUrl);
    }

    // 3. Enforce SINGLE study tab policy: close duplicates
    const updated = await this.cdp.targets();
    const studyTabs = updated.filter(p => p.url.includes('/mycourse/') || p.url.includes('/nodedetailcontroller/'));
    for (const s of studyTabs) {
      if (s.targetId !== studyTargetId) {
        try { await this.cdp.closeTarget(s.targetId); } catch {}
      }
    }

    // 4. Wait for study page to load
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const loaded = await this.cdp.evaluate(studyTargetId, 'Boolean(document.querySelector("#mainid"))');
      if (loaded) break;
    }

    await this.saveSession({ studyTargetId });
    return studyTargetId;
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
    let session = await this.loadSession();
    let categories = session.categories;
    if (!categories || categories.length === 0) {
      categories = await this.getCourseCategories(plaza.targetId);
      await this.saveSession({ categories, currentCategoryIndex: 0 });
    }
    const currentCat = categories[session.currentCategoryIndex || 0] || categories[0];
    const knowledges = await this.getCategoryKnowledgeList(currentCat.classifyId, plaza.targetId);
    if (knowledges && knowledges.length > 0) {
      return this.openStudyChapter(knowledges[0]);
    }

    // Fallback: click first link from plaza
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

  async advanceToNextChapter(studyTargetId) {
    // 1. Try clicking "下一节" button within current module
    const advanced = await this.advanceChapter(studyTargetId);
    if (advanced) {
      await sleep(1500);
      return { success: true, method: 'next_button' };
    }

    // 2. "下一节" ended: find next unvisited chapter in current category or switch to next category
    await this.loadSession();
    let categories = this.session.categories;
    if (!categories || categories.length === 0) {
      const { plaza } = await this.getTabs();
      categories = await this.getCourseCategories(plaza?.targetId);
      await this.saveSession({ categories });
    }

    let catIndex = this.session.currentCategoryIndex !== undefined ? this.session.currentCategoryIndex : 0;
    const visited = new Set(this.session.visitedChapters || []);

    while (catIndex < categories.length) {
      const cat = categories[catIndex];
      const { plaza } = await this.getTabs();
      const knowledges = await this.getCategoryKnowledgeList(cat.classifyId, plaza?.targetId);
      const unvisited = knowledges.filter(kId => !visited.has(String(kId)));

      if (unvisited.length > 0) {
        const nextKId = unvisited[0];
        await this.saveSession({ currentCategoryIndex: catIndex });
        const newStudyId = await this.openStudyChapter(nextKId);
        return {
          success: true,
          method: 'category_jump',
          category: cat.title,
          classifyId: cat.classifyId,
          knowledgeId: nextKId,
          studyTargetId: newStudyId
        };
      }

      // Current category exhausted, step to next category
      catIndex++;
    }

    return { success: false, method: 'exhausted' };
  }

  async nextQuiz() {
    let studyTargetId = await this.ensureSingleStudyTab();
    await this.loadSession();
    const visited = new Set(this.session.visitedChapters || []);

    // Loop until we find a chapter with an incomplete assessment
    for (let attempt = 0; attempt < 80; attempt++) {
      // 1. Wait for chapter header
      let chapterTitle = null;
      let chapterId = null;
      for (let i = 0; i < 25; i++) {
        const headerInfo = await this.cdp.evaluate(studyTargetId, `(()=>{
          const header = document.querySelector('#mainid');
          if (!header) return null;
          return {
            title: header.innerText.split('\\n')[0].trim(),
            chapterId: new URL(location.href).searchParams.get('chapterId')
          };
        })()`);
        if (headerInfo) {
          chapterTitle = headerInfo.title;
          chapterId = headerInfo.chapterId;
          break;
        }
        await sleep(300);
      }

      if (chapterId) {
        visited.add(String(chapterId));
        await this.saveSession({ visitedChapters: [...visited] });
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
              const isCheckbox = q.querySelector('li[role=checkbox]') !== null;
              let type = '未知题型';
              if (isRadio) type = opts.length === 2 ? '判断题' : '单选题';
              else if (isCheckbox) type = '多选题';
              return {
                index: idx,
                type,
                optionCount: opts.length
              };
            });
          })()`);

          // If any question has 0 options (e.g. subjective/fill-in-the-blank), skip chapter safely
          const hasUnsupported = questions.some(q => q.optionCount === 0);
          if (hasUnsupported) {
            process.stdout.write(`【提示】章节 ${quizStatus.title || chapterTitle || chapterId} 包含主观或非选择题型，自动跳过此章...\n`);
            const adv = await this.advanceToNextChapter(studyTargetId);
            if (!adv.success) {
              return { status: 'NO_MORE_CHAPTERS', message: 'All course categories and chapters scanned.' };
            }
            if (adv.studyTargetId) studyTargetId = adv.studyTargetId;
            continue;
          }

          return {
            status: 'QUIZ_READY',
            chapterId: quizStatus.chapterId || chapterId,
            title: quizStatus.title || chapterTitle,
            questionCount: quizStatus.questionCount,
            questions,
            screenshot: screenshotPath
          };
        }
      }

      // 3. No incomplete quiz on this chapter, advance to next chapter (or next category!)
      const adv = await this.advanceToNextChapter(studyTargetId);
      if (!adv.success) {
        return {
          status: 'NO_MORE_CHAPTERS',
          message: 'All course categories and chapters scanned.'
        };
      }
      if (adv.studyTargetId) {
        studyTargetId = adv.studyTargetId;
      }
      await sleep(1500);
    }

    return { status: 'TIMEOUT', message: 'Exceeded maximum chapter scanning attempts' };
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
    const session = await this.loadSession();
    const previousScore = session.lastScore || null;

    // 1. Submit current quiz
    const subResult = await this.submitQuiz(answers);
    await sleep(1500);

    // 2. Check plaza score (with retry if score not yet updated)
    const score = await this.getScore(this.session?.plazaTargetId, previousScore);

    let consecutiveZeroGain = session.consecutiveZeroGain || 0;
    if (score.total !== null && previousScore !== null) {
      if (score.total <= previousScore) {
        consecutiveZeroGain++;
      } else {
        consecutiveZeroGain = 0;
      }
    }
    await this.saveSession({ lastScore: score.total, consecutiveZeroGain });

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
      await this.advanceToNextChapter(study.targetId);
      await sleep(1500);
    }

    const next = await this.nextQuiz();
    const result = {
      status: next.status,
      currentScore: score.total,
      todayScore: score.today,
      remainingPoints: Math.max(0, this.targetScore - (score.total || 0)),
      nextQuiz: next
    };

    if (consecutiveZeroGain >= 3) {
      result.warning = `累计积分连续 ${consecutiveZeroGain} 节未发生增长（当前 ${score.total} 分）。可能该课程已触发【每日积分上限】或该题重复作答不计分。`;
    }

    return result;
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
      const url = getOpt('--url', 'https://tsjy.chaoxing.com/');
      const course = getOpt('--course', null);
      const res = await booster.init(url, getOpt('--chrome'), course);
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
    } else if (cmd === 'auto-fast') {
      const { runFastBooster } = await import('./fast-runner.mjs');
      const res = await runFastBooster({ stateDir, target: targetScore, onProgress: console.log });
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log('Commands:');
      console.log('  init [--url <URL>] [--course <KEYWORD>] [--state-dir ./state] [--target 800]');
      console.log('  status [--state-dir ./state]');
      console.log('  next-quiz [--state-dir ./state]');
      console.log('  submit "<answers_json>" [--state-dir ./state]');
      console.log('  step "<answers_json>" [--state-dir ./state]');
      console.log('  auto-fast [--state-dir ./state] [--target 800]');
      console.log('  finish [--state-dir ./state]');
    }
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }, null, 2));
    process.exit(1);
  } finally {
    if (booster.cdp) booster.cdp.close();
  }
}
