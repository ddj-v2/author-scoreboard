import {
  Handler,
  PERM,
  PRIV,
  ProblemModel,
  SystemModel,
  User,
  UserModel,
  db,
  Context,
} from 'hydrooj';
import * as DocumentModel from 'hydrooj/src/model/document';

const documentCollection = db.collection('document');

function getRankingVisibilityFilter(viewer: User) {
  if (viewer.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) return {};
  return { hidden: false };
}

function getProfileVisibilityFilter(viewer: User, targetUid: number) {
  if (viewer.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || viewer._id === targetUid) return {};
  return { hidden: false };
}

async function getCreatedProblems(domainId: string, uid: number, viewer: User) {
  return ProblemModel.getMulti(
    domainId,
    {
      owner: uid,
      ...getProfileVisibilityFilter(viewer, uid),
    },
    ProblemModel.PROJECTION_LIST,
  ).toArray();
}

async function getAuthorRankRows(domainId: string, viewer: User, page: number) {
  const pageSize = SystemModel.get('pagination.ranking') || 50;
  const match = {
    domainId,
    docType: DocumentModel.TYPE_PROBLEM,
    owner: { $gt: 1 },
    ...getRankingVisibilityFilter(viewer),
  };
  const grouped = [
    { $match: match },
    { $group: { _id: '$owner', problemCount: { $sum: 1 } } },
  ];
  const [countDocs, rows] = await Promise.all([
    documentCollection.aggregate([...grouped, { $count: 'count' }]).toArray(),
    documentCollection.aggregate([
      ...grouped,
      { $sort: { problemCount: -1, _id: 1 } },
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
    ]).toArray(),
  ]);

  const total = countDocs[0]?.count || 0;
  const udict = rows.length ? await UserModel.getList(domainId, rows.map((row) => row._id)) : {};
  const authorRows = rows.map((row) => {
    const udoc = udict[row._id];
    if (!udoc) {
      return {
        _id: row._id,
        uname: `User ${row._id}`,
        avatar: undefined,
        bio: '',
        problemCount: row.problemCount,
      };
    }
    return Object.assign(udoc, { problemCount: row.problemCount });
  });

  return {
    authorRows,
    pageSize,
    total,
    upcount: Math.ceil(total / pageSize),
  };
}

async function getSelfAuthorStats(domainId: string, viewer: User) {
  if (!viewer.hasPriv(PRIV.PRIV_USER_PROFILE)) return null;

  const match = {
    domainId,
    docType: DocumentModel.TYPE_PROBLEM,
    owner: viewer._id,
    ...getRankingVisibilityFilter(viewer),
  };
  const problemCount = await documentCollection.countDocuments(match);
  if (!problemCount) return null;

  const higherRankCount = await documentCollection.aggregate([
    {
      $match: {
        domainId,
        docType: DocumentModel.TYPE_PROBLEM,
        owner: { $gt: 1 },
        ...getRankingVisibilityFilter(viewer),
      },
    },
    { $group: { _id: '$owner', problemCount: { $sum: 1 } } },
    {
      $match: {
        $or: [
          { problemCount: { $gt: problemCount } },
          { problemCount, _id: { $lt: viewer._id } },
        ],
      },
    },
    { $count: 'count' },
  ]).toArray();

  return Object.assign(viewer, {
    problemCount,
    rank: (higherRankCount[0]?.count || 0) + 1,
  });
}

class AuthorRankingHandler extends Handler {
  async get({ domainId }: { domainId: string }) {
    const rawPage = Number(this.request.query.page);
    const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
    const [ranking, selfStats] = await Promise.all([
      getAuthorRankRows(domainId, this.user, page),
      getSelfAuthorStats(domainId, this.user),
    ]);

    this.response.template = 'author_ranking.html';
    this.response.body = {
      authorRows: ranking.authorRows,
      currentUserAuthorStats: selfStats,
      page,
      pageSize: ranking.pageSize,
      ucount: ranking.total,
      upcount: ranking.upcount,
    };
  }
}

async function extendUserDetail(handler: Handler) {
  if (handler.response.template !== 'user_detail.html') return;
  const udoc = handler.response.body?.udoc;
  if (!udoc?._id) return;

  const createdProblems = await getCreatedProblems(handler.args.domainId, udoc._id, handler.user);
  handler.response.body.createdProblems = createdProblems;
  handler.response.body.createdProblemCount = createdProblems.length;
}

function loadI18n(ctx: Context) {
  ctx.i18n.load('en', {
    author_ranking: 'Author Ranking',
    'Created Problems': 'Created Problems',
    'Problems Created': 'Problems Created',
    'This user has not created any problems in this domain yet.': 'This user has not created any problems in this domain yet.',
    'No users have created any visible problems in this domain yet.': 'No users have created any visible problems in this domain yet.',
  });
  ctx.i18n.load('zh', {
    author_ranking: '创题排名',
    'Created Problems': '创建的题目',
    'Problems Created': '创题数',
    'This user has not created any problems in this domain yet.': '该用户尚未在当前域创建题目。',
    'No users have created any visible problems in this domain yet.': '当前域暂无可见的创题记录。',
  });
  ctx.i18n.load('zh_TW', {
    author_ranking: '創題排名',
    'Created Problems': '創建的題目',
    'Problems Created': '創題數',
    'This user has not created any problems in this domain yet.': '該用戶尚未在當前域創建題目。',
    'No users have created any visible problems in this domain yet.': '當前域暫無可見的創題記錄。',
  });
}

async function apply(ctx: Context) {
  ctx.Route('author_ranking', '/ranking/author', AuthorRankingHandler, PERM.PERM_VIEW_RANKING);
  ctx.on('handler/after/UserDetail#get', extendUserDetail);
  loadI18n(ctx);
}

export { apply };
