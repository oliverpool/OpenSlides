# -*- coding: utf-8 -*-
# Generated by Django 1.10.2 on 2016-10-27 12:06
from __future__ import unicode_literals

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('motions', '0006_auto_20161017_2020'),
    ]

    operations = [
        migrations.AddField(
            model_name='state',
            name='show_recommendation_extension_field',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='state',
            name='show_state_extension_field',
            field=models.BooleanField(default=False),
        ),
    ]
