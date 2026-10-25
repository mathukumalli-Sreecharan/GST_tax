"""Explicit fixture-user decisions before exercising existing export regressions."""
def reviewed_post(client,path,**kwargs):
    response=client.post(path,**kwargs)
    if response.status_code!=200:
        return response
    review=response.json()
    assert 'review_id' in review and 'file_id' not in review
    for row in review['rows']:
        if row['status']=='MATCHED':
            continue
        decision={'version':review['version'],'choice':'CORRECT'} if row['rate'] is not None else {'version':review['version'],'choice':'WRONG','slab_count':1,'rates':[18]}
        saved=client.post(f"/api/excel/reviews/{review['review_id']}/rows/{row['excel_row']}",json=decision)
        assert saved.status_code==200,saved.text
        review=saved.json()
    return client.post('/api/excel/reviews/'+review['review_id']+'/generate')
